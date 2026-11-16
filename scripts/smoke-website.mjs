#!/usr/bin/env node
// Serves the static website export the way GitHub Pages does (under the base
// path, with 404.html for unknown routes) and checks the pages people land on,
// including the sandboxed Playground. External requests are blocked, so the
// check is deterministic and needs no network.
import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../apps/website/out");
const basePath = `/${(process.env.RENDERIFY_SITE_BASE_PATH ?? "renderify").replace(/^\/+|\/+$/g, "")}`;
const CONTENT_TYPES = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

if (!existsSync(root)) {
  console.error(`Missing ${root}; run the website build first.`);
  process.exit(1);
}

function resolveFile(urlPath) {
  for (const candidate of [
    urlPath,
    path.join(urlPath, "index.html"),
    `${urlPath}.html`,
  ]) {
    const full = path.normalize(path.join(root, candidate));
    if (!full.startsWith(root)) {
      return undefined;
    }
    try {
      if (statSync(full).isFile()) {
        return full;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const file = pathname.startsWith(basePath)
    ? resolveFile(pathname.slice(basePath.length) || "/")
    : undefined;
  const target = file ?? path.join(root, "404.html");
  response.writeHead(file ? 200 : 404, {
    "content-type":
      CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream",
  });
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const site = `${origin}${basePath}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );

  await page.goto(`${site}/`);
  await page.locator("#home-hero-title").waitFor();
  console.log("home: ok");

  await page.goto(`${site}/docs/getting-started/`);
  await page.locator("h1", { hasText: "Getting Started" }).waitFor();
  console.log("docs: ok");

  // The RuntimePlan sample renders inside the sandboxed frame without network.
  await page.goto(`${site}/playground/`);
  await page.getByRole("tab", { name: "RuntimePlan JSON" }).click();
  const status = page.locator(".playground-status");
  await status.filter({ hasText: /Rendered in/ }).waitFor({ timeout: 60_000 });
  const iframe = page.locator(".playground-preview iframe");
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
  const preview = page.frameLocator(".playground-preview iframe");
  await preview.getByRole("button", { name: "+1" }).click();
  await preview.locator("h1", { hasText: "1" }).waitFor();
  console.log("playground: ok");

  const missing = await page.goto(`${site}/missing-page/`);
  assert.equal(missing?.status(), 404);
  console.log("404: ok");

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("Website smoke checks passed.");
} finally {
  await browser.close();
  server.close();
}
