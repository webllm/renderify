import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";

const REPO_ROOT = process.cwd();
const ORIGIN = "http://react.test";
const SOURCE_ALIASES = {
  "@renderify/ir": path.join(REPO_ROOT, "packages/ir/src/index.ts"),
  "@renderify/security": path.join(REPO_ROOT, "packages/security/src/index.ts"),
  "@renderify/runtime": path.join(REPO_ROOT, "packages/runtime/src/index.ts"),
  "@renderify/frame": path.join(REPO_ROOT, "packages/frame/src/index.ts"),
  "@renderify/react": path.join(REPO_ROOT, "packages/react/src/index.ts"),
};

const APP_SOURCE = `
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RenderifyFrame, RenderifyView } from "@renderify/react";

const counter = (label) => ({
  specVersion: "runtime-plan/v1",
  id: "react_counter_" + label,
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "section",
    children: [
      { type: "element", tag: "h1", children: [{ type: "text", value: label + " {{state.count}}" }] },
      { type: "element", tag: "button", props: { id: "increment", onClick: "increment" }, children: [{ type: "text", value: "+1" }] },
    ],
  },
  state: {
    initial: { count: 0 },
    transitions: { increment: [{ type: "increment", path: "count" }] },
  },
});

const rejected = {
  specVersion: "runtime-plan/v1",
  id: "react_rejected",
  version: 1,
  capabilities: { domWrite: true },
  root: { type: "text", value: "unused" },
  source: { language: "jsx", code: "export default () => null" },
};

function App() {
  const [plan, setPlan] = useState(counter("First"));
  const [visible, setVisible] = useState(true);
  const [events, setEvents] = useState([]);
  const [actions, setActions] = useState([]);
  return (
    <main>
      <button id="same" onClick={() => setPlan(JSON.parse(JSON.stringify(plan)))}>same</button>
      <button id="next" onClick={() => setPlan(counter("Second"))}>next</button>
      <button id="reject" onClick={() => setPlan(rejected)}>reject</button>
      <button id="toggle" onClick={() => setVisible((value) => !value)}>toggle</button>
      {visible ? (
        <RenderifyView
          className="view"
          plan={plan}
          onEvent={(event, state) => setEvents((list) => [...list, event.type + ":" + state?.count])}
          renderError={(error) => <p id="error">{error.message}</p>}
        />
      ) : null}
      <pre id="events">{JSON.stringify(events)}</pre>
      <RenderifyFrame
        className="frame"
        runnerUrl="/runner.js"
        runtime="renderify"
        allowedActions={["greet"]}
        source={'export default function App() { return <p id="framed">Framed JSX</p>; }'}
        onAction={(action) => setActions((list) => [...list, action.type])}
        onResult={() => document.body.setAttribute("data-frame-rendered", "true")}
      />
      <pre id="actions">{JSON.stringify(actions)}</pre>
    </main>
  );
}

createRoot(document.getElementById("app")).render(<StrictMode><App /></StrictMode>);
`;

let bundles: Promise<{ app: string; runner: string }> | undefined;

function loadBundles() {
  bundles ??= (async () => {
    const [app, runner] = await Promise.all([
      build({
        stdin: {
          contents: APP_SOURCE,
          resolveDir: path.join(REPO_ROOT, "packages/react"),
          sourcefile: "react-harness.tsx",
          loader: "tsx",
        },
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        write: false,
        logLevel: "silent",
        external: ["node:*"],
        alias: SOURCE_ALIASES,
        define: { "process.env.NODE_ENV": '"development"' },
      }),
      build({
        entryPoints: [path.join(REPO_ROOT, "packages/frame/src/runner.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
        external: ["node:*"],
        alias: SOURCE_ALIASES,
        define: { "process.env.NODE_ENV": '"production"' },
      }),
    ]);
    return {
      app: app.outputFiles[0]?.text ?? "",
      runner: runner.outputFiles[0]?.text ?? "",
    };
  })();
  return bundles;
}

async function openApp(
  browser: Browser,
): Promise<{ page: Page; errors: string[] }> {
  const { app, runner } = await loadBundles();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      await route.abort();
      return;
    }
    if (url.pathname === "/runner.js") {
      await route.fulfill({ body: runner, contentType: "text/javascript" });
      return;
    }
    if (url.pathname === "/app.js") {
      await route.fulfill({ body: app, contentType: "text/javascript" });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="app"></div><script src="/app.js"></script>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  return { page, errors };
}

test("e2e: RenderifyView and RenderifyFrame work inside a React app", async (t) => {
  let browser: Browser | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      t.skip(
        `playwright chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const { page, errors } = await openApp(browser);
    const view = page.locator(".view");
    await view.getByText("First 0").waitFor();
    assert.equal(await view.getAttribute("data-renderify-status"), "ready");

    // StrictMode mounts effects twice; there must still be one live session.
    await view.locator("#increment").click();
    await view.getByText("First 1").waitFor();
    await page.locator("#events", { hasText: '["increment:1"]' }).waitFor();

    // An equal plan object keeps the session and its state.
    await page.locator("#same").click();
    await page.waitForTimeout(150);
    assert.equal(await view.locator("h1").textContent(), "First 1");

    // New plan content mounts a fresh session.
    await page.locator("#next").click();
    await view.getByText("Second 0").waitFor();
    await view.locator("#increment").click();
    await view.getByText("Second 1").waitFor();
    await page
      .locator("#events", { hasText: '["increment:1","increment:1"]' })
      .waitFor();

    // Policy rejections surface through renderError, not a crash.
    await page.locator("#reject").click();
    await page.locator("#error").waitFor();
    assert.equal(await view.getAttribute("data-renderify-status"), "error");
    assert.equal(await view.innerHTML(), "");

    // Unmounting removes the rendered content cleanly.
    await page.locator("#toggle").click();
    assert.equal(await page.locator(".view").count(), 0);

    // The sandboxed frame renders model-written JSX.
    await page.waitForSelector('body[data-frame-rendered="true"]');
    const frame = await (
      await page.waitForSelector(".frame iframe")
    ).contentFrame();
    assert.ok(frame);
    await frame.locator("#framed").waitFor();
    assert.equal(
      await page.locator(".frame iframe").getAttribute("sandbox"),
      "allow-scripts",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
  }
});
