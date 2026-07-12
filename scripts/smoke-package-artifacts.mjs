#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const libraryPackages = [
  "ir",
  "security",
  "runtime",
  "core",
  "llm",
  "mcp-app",
  "renderify",
];

for (const name of libraryPackages) {
  const distDirectory = path.join(root, "packages", name, "dist");
  const esmPath = path.join(distDirectory, `${name}.mjs`);
  const cjsPath = path.join(distDirectory, `${name}.cjs`);

  const esmNamespace = await import(pathToFileURL(esmPath).href);
  assert.ok(
    Object.keys(esmNamespace).length > 0,
    `${name} ESM artifact has no exports`,
  );

  const cjsNamespace = require(cjsPath);
  assert.ok(
    cjsNamespace && Object.keys(cjsNamespace).length > 0,
    `${name} CommonJS artifact has no exports`,
  );
}

for (const relativePath of [
  "packages/mcp-app/dist/view.mjs",
  "packages/mcp-app/dist/view.cjs",
]) {
  const namespace = relativePath.endsWith(".mjs")
    ? await import(pathToFileURL(path.join(root, relativePath)).href)
    : require(path.join(root, relativePath));
  assert.equal(
    typeof namespace.startRenderifyMcpApp,
    "function",
    `${relativePath} is missing startRenderifyMcpApp`,
  );
}

const mcpAppEsm = await import(
  pathToFileURL(path.join(root, "packages/mcp-app/dist/mcp-app.mjs")).href
);
const mcpAppCjs = require(path.join(root, "packages/mcp-app/dist/mcp-app.cjs"));
for (const [format, namespace] of [
  ["ESM", mcpAppEsm],
  ["CommonJS", mcpAppCjs],
]) {
  const shell = await namespace.createRenderifyShell();
  assert.match(shell.html, /Content-Security-Policy/);
  assert.equal(shell.csp.includes("unsafe-eval"), false);
  assert.equal(
    shell.csp.includes("script-src 'unsafe-inline'"),
    false,
    `${format} MCP App shell uses script unsafe-inline`,
  );
}

const mcpAppDirectory = path.join(root, "packages/mcp-app");
assert.doesNotMatch(
  fs.readFileSync(path.join(mcpAppDirectory, "README.md"), "utf8"),
  /\]\(\/docs\//,
  "@renderify/mcp-app README contains repository-root links that break on npm",
);
assert.equal(
  fs.readFileSync(path.join(mcpAppDirectory, "LICENSE"), "utf8"),
  fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  "@renderify/mcp-app LICENSE differs from the repository license",
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packOutput = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
  cwd: mcpAppDirectory,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const [packManifest] = JSON.parse(packOutput);
assert.ok(
  packManifest?.files?.some((entry) => entry.path === "LICENSE"),
  "@renderify/mcp-app package tarball is missing LICENSE",
);

for (const relativePath of [
  "packages/cli/dist/cli.mjs",
  "packages/cli/dist/cli.cjs",
  "packages/cli/bin/renderify.js",
]) {
  execFileSync(process.execPath, ["--check", path.join(root, relativePath)], {
    stdio: "pipe",
  });
}

console.log("Package artifact smoke checks passed.");
