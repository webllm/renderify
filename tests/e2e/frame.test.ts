import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Frame, type Page } from "playwright";

const REPO_ROOT = process.cwd();
const ORIGIN = "http://frame.test";
const SOURCE_ALIASES = {
  "@renderify/ir": path.join(REPO_ROOT, "packages/ir/src/index.ts"),
  "@renderify/security": path.join(REPO_ROOT, "packages/security/src/index.ts"),
  "@renderify/runtime": path.join(REPO_ROOT, "packages/runtime/src/index.ts"),
};

interface Bundles {
  host: string;
  runner: string;
  planRunner: string;
  runnerIntegrity: string;
}

let bundles: Promise<Bundles> | undefined;

function loadBundles(): Promise<Bundles> {
  bundles ??= (async () => {
    const [host, runner, planRunner] = await Promise.all([
      build({
        entryPoints: [path.join(REPO_ROOT, "packages/frame/src/index.ts")],
        bundle: true,
        format: "iife",
        globalName: "RenderifyFrame",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
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
      build({
        entryPoints: [
          path.join(REPO_ROOT, "packages/frame/src/runner-plan.ts"),
        ],
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
    const runnerText = runner.outputFiles[0]?.text ?? "";
    return {
      host: host.outputFiles[0]?.text ?? "",
      runner: runnerText,
      planRunner: planRunner.outputFiles[0]?.text ?? "",
      runnerIntegrity: `sha384-${createHash("sha384").update(runnerText).digest("base64")}`,
    };
  })();
  return bundles;
}

async function openHost(browser: Browser): Promise<Page> {
  const { host, runner, planRunner } = await loadBundles();
  const page = await browser.newPage();
  // tsx wraps named functions in __name(); evaluated callbacks need it too.
  await page.addInitScript("globalThis.__name = (target) => target;");
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/npm:never-loads@")) {
      // Simulates a CDN that never answers; the request stays pending.
      return;
    }
    if (url.origin !== ORIGIN) {
      // The tests run offline; nothing may leave the sandbox.
      await route.abort();
      return;
    }
    if (url.pathname === "/runner.js") {
      await route.fulfill({
        body: runner,
        contentType: "text/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
      return;
    }
    if (url.pathname === "/runner-plan.js") {
      await route.fulfill({ body: planRunner, contentType: "text/javascript" });
      return;
    }
    if (url.pathname === "/host.js") {
      await route.fulfill({ body: host, contentType: "text/javascript" });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Host page</title><main id="host"></main><script src="/host.js"></script>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => {
    const host = globalThis as unknown as Record<string, unknown>;
    host.__actions = [];
    host.__blocked = [];
    host.__runtimeErrors = [];
    host.__statuses = [];
  });
  return page;
}

async function createFrame(
  page: Page,
  options: Record<string, unknown> = {},
): Promise<void> {
  await page.evaluate((frameOptions) => {
    const host = globalThis as unknown as {
      RenderifyFrame: {
        createRenderifyFrame(options: Record<string, unknown>): unknown;
      };
      __frame: unknown;
      __actions: unknown[];
      __blocked: unknown[];
      __runtimeErrors: unknown[];
      __statuses: unknown[];
    };
    host.__frame = host.RenderifyFrame.createRenderifyFrame({
      container: document.getElementById("host"),
      runnerUrl: "/runner.js",
      allowedActions: ["save"],
      onAction: (action: unknown) => host.__actions.push(action),
      onBlockedAction: (action: unknown) => host.__blocked.push(action),
      onRuntimeError: (message: unknown) => host.__runtimeErrors.push(message),
      onStatusChange: (status: unknown) => host.__statuses.push(status),
      ...frameOptions,
    });
  }, options);
}

async function renderInFrame(
  page: Page,
  input: unknown,
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string }
> {
  return page.evaluate(async (json) => {
    const frame = (
      globalThis as unknown as {
        __frame: { render(input: unknown): Promise<Record<string, unknown>> };
      }
    ).__frame;
    try {
      return {
        ok: true as const,
        result: await frame.render(JSON.parse(json)),
      };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        ok: false as const,
        code: String(failure.code),
        message: String(failure.message),
      };
    }
  }, JSON.stringify(input));
}

async function sandboxFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector("#host iframe");
  const frame = await handle.contentFrame();
  assert.ok(frame, "sandbox frame is missing");
  return frame;
}

const ACTION_PLAN = {
  specVersion: "runtime-plan/v1",
  id: "frame_actions",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "div",
    children: [
      {
        type: "element",
        tag: "button",
        props: { id: "save", onClick: { type: "save", payload: { id: 7 } } },
        children: [{ type: "text", value: "Save" }],
      },
      {
        type: "element",
        tag: "button",
        props: { id: "delete", onClick: "delete" },
        children: [{ type: "text", value: "Delete" }],
      },
      {
        type: "element",
        tag: "p",
        children: [{ type: "text", value: "Count {{state.count}}" }],
      },
    ],
  },
  state: {
    initial: { count: 0 },
    transitions: { save: [{ type: "increment", path: "count" }] },
  },
};

async function withBrowser(
  t: { skip(message: string): void },
  run: (browser: Browser) => Promise<void>,
): Promise<void> {
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
    await run(browser);
  } finally {
    await browser?.close();
  }
}

test("e2e: frame renders plans offline and delivers only allowlisted actions", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await openHost(browser);
    await createFrame(page);
    const rendered = await renderInFrame(page, { plan: ACTION_PLAN });
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.equal(rendered.result.framework, "runtime-plan");
      assert.equal(rendered.result.planId, "frame_actions");
    }

    const frame = await sandboxFrame(page);
    await frame.locator("#save").click();
    await frame.getByText("Count 1").waitFor();
    await frame.locator("#delete").click();
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { __blocked: unknown[] }).__blocked.length ===
        1,
    );
    const delivered = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __actions: unknown[];
        __blocked: unknown[];
        __statuses: unknown[];
      };
      return {
        actions: host.__actions,
        blocked: host.__blocked,
        statuses: host.__statuses,
      };
    });
    assert.deepEqual(delivered.actions, [{ type: "save", payload: { id: 7 } }]);
    assert.deepEqual(delivered.blocked, [{ type: "delete" }]);
    assert.deepEqual(delivered.statuses, ["ready", "rendering", "rendered"]);
  });
});

test("e2e: frame renders JSX source and sizes itself to the content", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await openHost(browser);
    await createFrame(page);
    const rendered = await renderInFrame(page, {
      runtime: "renderify",
      source:
        'export default function App() { return <section style={{ height: "240px" }}>Hello frame</section>; }',
    });
    assert.equal(rendered.ok, true, JSON.stringify(rendered));
    const frame = await sandboxFrame(page);
    await frame.getByText("Hello frame").waitFor();
    await page.waitForFunction(
      () =>
        (document.querySelector("#host iframe") as HTMLIFrameElement).style
          .height === "240px",
    );
  });
});

test("e2e: loop guards stop runaway code and the watchdog resets hung renders", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await openHost(browser);
    await createFrame(page, { loopTimeoutMs: 200, timeoutMs: 2_000 });

    const looping = await renderInFrame(page, {
      runtime: "renderify",
      source:
        "export default function App() { let n = 0; while (true) { n += 1; } return <p>{n}</p>; }",
    });
    // The guard throws inside the component; the runtime reports it as an
    // error diagnostic and the frame stays responsive.
    assert.equal(looping.ok, true, JSON.stringify(looping));
    if (looping.ok) {
      const diagnostics = looping.result.diagnostics as Array<{
        level: string;
        message: string;
      }>;
      assert.ok(
        diagnostics.some(
          (item) =>
            item.level === "error" &&
            /Renderify stopped a loop that ran longer than 200 ms/.test(
              item.message,
            ),
        ),
        JSON.stringify(diagnostics),
      );
    }

    const firstFrame = await page.evaluate(
      () =>
        (document.querySelector("#host iframe") as HTMLIFrameElement)
          .isConnected,
    );
    assert.equal(firstFrame, true);
    const hung = await renderInFrame(page, {
      runtime: "renderify",
      source:
        'import value from "https://ga.jspm.io/npm:never-loads@1.0.0/index.js";\nexport default function App() { return <p>{value}</p>; }',
    });
    assert.equal(hung.ok, false, JSON.stringify(hung));
    if (!hung.ok) {
      assert.equal(hung.code, "timeout");
    }
    await page.waitForFunction(() =>
      (globalThis as unknown as { __statuses: string[] }).__statuses.includes(
        "timed-out",
      ),
    );

    // The watchdog replaced the frame; the next render works.
    const recovered = await renderInFrame(page, { plan: ACTION_PLAN });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(await page.locator("#host iframe").count(), 1);
  });
});

test("e2e: only the parent connects, once, and content cannot reach the host", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await openHost(browser);
    await createFrame(page);
    assert.equal((await renderInFrame(page, { plan: ACTION_PLAN })).ok, true);

    // A second connection attempt is ignored, even from the parent.
    const hijacked = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const iframe = document.querySelector(
            "#host iframe",
          ) as HTMLIFrameElement;
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve(true);
          iframe.contentWindow?.postMessage(
            { type: "renderify-frame-connect", protocol: "renderify-frame/1" },
            "*",
            [channel.port2],
          );
          setTimeout(() => resolve(false), 500);
        }),
    );
    assert.equal(hijacked, false);

    const frame = await sandboxFrame(page);
    const probes = await frame.evaluate(() => {
      const attempt = (read: () => unknown) => {
        try {
          return String(read());
        } catch {
          return "blocked";
        }
      };
      return {
        parentDocument: attempt(() => window.parent.document.title),
        cookie: attempt(() => document.cookie),
        storage: attempt(() => window.localStorage.length),
        origin: window.origin,
      };
    });
    assert.deepEqual(probes, {
      parentDocument: "blocked",
      cookie: "blocked",
      storage: "blocked",
      origin: "null",
    });
  });
});

test("e2e: theme variables apply inside the frame", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await openHost(browser);
    await createFrame(page, {
      theme: { variables: { "--accent": "rgb(255, 0, 0)" } },
    });
    assert.equal((await renderInFrame(page, { plan: ACTION_PLAN })).ok, true);
    const frame = await sandboxFrame(page);
    const readTheme = () =>
      frame.evaluate(() => ({
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim(),
        scheme: document.documentElement.style.colorScheme,
      }));
    assert.deepEqual(await readTheme(), {
      accent: "rgb(255, 0, 0)",
      scheme: "",
    });

    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __frame: { setTheme(theme: unknown): void };
        }
      ).__frame.setTheme({
        colorScheme: "dark",
        variables: { "--accent": "rgb(0, 0, 255)" },
      }),
    );
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim() === "rgb(0, 0, 255)",
    );
    assert.deepEqual(await readTheme(), {
      accent: "rgb(0, 0, 255)",
      scheme: "dark",
    });
  });
});

test("e2e: the runner must match its integrity hash", async (t) => {
  await withBrowser(t, async (browser) => {
    const { runnerIntegrity } = await loadBundles();
    const page = await openHost(browser);
    await createFrame(page, {
      runnerIntegrity: `sha384-${"A".repeat(64)}`,
      bootTimeoutMs: 1_500,
    });
    const tampered = await renderInFrame(page, { plan: ACTION_PLAN });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) {
      assert.equal(tampered.code, "boot-failed");
    }

    await page.evaluate(() =>
      (
        globalThis as unknown as { __frame: { dispose(): void } }
      ).__frame.dispose(),
    );
    assert.equal(await page.locator("#host iframe").count(), 0);
    await createFrame(page, { runnerIntegrity });
    assert.equal((await renderInFrame(page, { plan: ACTION_PLAN })).ok, true);
  });
});

test("e2e: the plan-only runner renders plans and rejects source", async (t) => {
  await withBrowser(t, async (browser) => {
    const { runner, planRunner } = await loadBundles();
    assert.ok(
      planRunner.length * 5 < runner.length,
      "plan runner is not small",
    );
    const page = await openHost(browser);
    await createFrame(page, { runnerUrl: "/runner-plan.js" });
    const rendered = await renderInFrame(page, { plan: ACTION_PLAN });
    assert.equal(rendered.ok, true, JSON.stringify(rendered));
    const frame = await sandboxFrame(page);
    await frame.locator("#save").click();
    await frame.getByText("Count 1").waitFor();

    const source = await renderInFrame(page, {
      runtime: "renderify",
      source: "export default function App() { return <p>source</p>; }",
    });
    assert.equal(source.ok, false);
    if (!source.ok) {
      assert.equal(source.code, "render-failed");
      assert.match(source.message, /declarative RuntimePlans only/);
    }
  });
});
