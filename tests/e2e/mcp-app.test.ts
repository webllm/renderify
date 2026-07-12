import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { RuntimePlan } from "../../packages/ir/src/index";
import {
  bundleRenderifyMcpView,
  createRenderifyShell,
  planPayload,
  renderifyToolResult,
} from "../../packages/mcp-app/src/index";

interface BrowserHostState {
  initialized: number;
  appInfo?: { name: string; version: string };
  modelContexts: Array<Record<string, unknown>>;
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  teardownResult?: Record<string, unknown>;
}

interface BrowserListenerStats {
  added: Record<string, number>;
  removed: Record<string, number>;
}

interface BrowserToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface BrowserBridge {
  onupdatemodelcontext?: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  oncalltool?: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<BrowserToolResult>;
  oninitialized?: () => void;
  getAppVersion(): { name: string; version: string } | undefined;
  sendToolInput(params: { arguments?: Record<string, unknown> }): Promise<void>;
  sendToolResult(result: BrowserToolResult): Promise<void>;
  connect(transport: object): Promise<void>;
  teardownResource(params: object): Promise<Record<string, unknown>>;
}

interface BrowserHostModule {
  AppBridge: new (
    client: null,
    hostInfo: { name: string; version: string },
    capabilities: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => BrowserBridge;
  PostMessageTransport: new (
    eventTarget: Window,
    eventSource: MessageEventSource,
  ) => object;
}

function createInteractivePlan(): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "mcp_browser_plan",
    version: 1,
    capabilities: { domWrite: true },
    state: {
      initial: { count: 0 },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
    root: {
      type: "element",
      tag: "section",
      children: [
        {
          type: "element",
          tag: "h2",
          children: [{ type: "text", value: "MCP dashboard" }],
        },
        {
          type: "element",
          tag: "p",
          props: { id: "count" },
          children: [{ type: "text", value: "Count={{state.count}}" }],
        },
        {
          type: "element",
          tag: "button",
          props: { id: "increment", type: "button", onClick: "increment" },
          children: [{ type: "text", value: "Increment" }],
        },
        {
          type: "element",
          tag: "button",
          props: {
            id: "refresh",
            type: "button",
            onClick: {
              type: "tool:refresh_dashboard",
              payload: { source: "mcp-app" },
            },
          },
          children: [{ type: "text", value: "Refresh" }],
        },
        {
          type: "element",
          tag: "button",
          props: {
            id: "blocked-tool",
            type: "button",
            onClick: "tool:not_allowlisted",
          },
          children: [{ type: "text", value: "Blocked tool" }],
        },
      ],
    },
  };
}

function createTextPlan(id: string, text: string): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id,
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: text }],
    },
  };
}

function createDeferredRefreshPlan(): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "refreshed_plan",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [
        { type: "text", value: "Refreshed safely" },
        {
          type: "element",
          tag: "button",
          props: {
            id: "same-refresh",
            type: "button",
            onClick: {
              type: "tool:refresh_dashboard",
              payload: { mode: "same" },
            },
          },
          children: [{ type: "text", value: "Refresh same view" }],
        },
        {
          type: "element",
          tag: "button",
          props: {
            id: "deferred-refresh",
            type: "button",
            onClick: {
              type: "tool:refresh_dashboard",
              payload: { mode: "deferred" },
            },
          },
          children: [{ type: "text", value: "Deferred refresh" }],
        },
        {
          type: "element",
          tag: "button",
          props: {
            id: "error-refresh",
            type: "button",
            onClick: {
              type: "tool:refresh_dashboard",
              payload: { mode: "error" },
            },
          },
          children: [{ type: "text", value: "Error refresh" }],
        },
      ],
    },
  };
}

function createOverDepthPlan(): RuntimePlan {
  let root: RuntimePlan["root"] = { type: "text", value: "too deep" };
  for (let index = 0; index < 10; index += 1) {
    root = { type: "element", tag: "div", children: [root] };
  }
  return {
    specVersion: "runtime-plan/v1",
    id: "over_depth_plan",
    version: 1,
    capabilities: { domWrite: true },
    root,
  };
}

function createFragmentNavigationPlan(): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "fragment_navigation_plan",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "a",
      props: { id: "fragment-navigation", href: "#host-route" },
      children: [{ type: "text", value: "Leave the app" }],
    },
  };
}

test("e2e: official AppBridge drives the offline Renderify MCP App lifecycle", async () => {
  const hostBundle = await bundleOfficialHostBridge();
  const viewBundle = await bundleRenderifyMcpView();
  const shell = await createRenderifyShell({
    browserBundle: instrumentMountListeners(viewBundle.code),
    allowedTools: ["refresh_dashboard"],
  });
  const initialResult = asBrowserToolResult(
    renderifyToolResult(planPayload(createInteractivePlan())),
  );
  const refreshedResult = asBrowserToolResult(
    renderifyToolResult(planPayload(createDeferredRefreshPlan())),
  );
  const lateResult = asBrowserToolResult(
    renderifyToolResult(
      planPayload(createTextPlan("late_plan", "LATE RESULT")),
    ),
  );
  const errorResult = asBrowserToolResult(
    renderifyToolResult(
      planPayload(createTextPlan("error_plan", "ERROR PLAN RENDERED")),
      { summary: "Expected tool failure" },
    ),
  );
  errorResult.isError = true;
  const spoofedResult = asBrowserToolResult(
    renderifyToolResult(
      planPayload(createTextPlan("spoofed_plan", "SPOOFED RESULT")),
    ),
  );

  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleMessages: string[] = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) =>
    consoleMessages.push(`${message.type()}: ${message.text()}`),
  );

  try {
    await page.setContent(
      '<iframe id="app" name="app" sandbox="allow-scripts"></iframe><iframe id="attacker" name="attacker"></iframe>',
    );
    await page.addScriptTag({ content: hostBundle });
    await page.evaluate(
      async ({
        shellHtml,
        firstResult,
        nextResult,
        deferredResult,
        toolErrorResult,
      }: {
        shellHtml: string;
        firstResult: BrowserToolResult;
        nextResult: BrowserToolResult;
        deferredResult: BrowserToolResult;
        toolErrorResult: BrowserToolResult;
      }) => {
        const hostModule = (
          globalThis as unknown as { McpAppsHost: BrowserHostModule }
        ).McpAppsHost;
        const iframe = document.querySelector<HTMLIFrameElement>("#app");
        if (!iframe?.contentWindow) {
          throw new Error("MCP App iframe is unavailable");
        }

        const state: BrowserHostState = {
          initialized: 0,
          modelContexts: [],
          toolCalls: [],
        };
        const bridge = new hostModule.AppBridge(
          null,
          { name: "Renderify conformance host", version: "1.0.0" },
          {
            serverTools: {},
            updateModelContext: { structuredContent: {} },
          },
          { hostContext: { theme: "light", locale: "en-US" } },
        );
        bridge.onupdatemodelcontext = async (params) => {
          state.modelContexts.push(params as Record<string, unknown>);
          return {};
        };
        bridge.oncalltool = async (params) => {
          state.toolCalls.push(params);
          if (params.arguments?.mode === "error") {
            return toolErrorResult;
          }
          if (params.arguments?.mode === "deferred") {
            return new Promise<BrowserToolResult>((resolve) => {
              (
                globalThis as unknown as {
                  __resolvePendingMcpTool: () => void;
                }
              ).__resolvePendingMcpTool = () => resolve(deferredResult);
            });
          }
          return nextResult;
        };
        bridge.oninitialized = () => {
          state.initialized += 1;
          state.appInfo = bridge.getAppVersion();
          void bridge
            .sendToolInput({ arguments: {} })
            .then(() => bridge.sendToolResult(firstResult));
        };

        const transport = new hostModule.PostMessageTransport(
          iframe.contentWindow,
          iframe.contentWindow,
        );
        await bridge.connect(transport);
        (
          globalThis as unknown as {
            __mcpBridge: BrowserBridge;
            __mcpHostState: BrowserHostState;
          }
        ).__mcpBridge = bridge;
        (
          globalThis as unknown as { __mcpHostState: BrowserHostState }
        ).__mcpHostState = state;
        iframe.srcdoc = shellHtml;
      },
      {
        shellHtml: shell.html,
        firstResult: initialResult,
        nextResult: refreshedResult,
        deferredResult: lateResult,
        toolErrorResult: errorResult,
      },
    );

    const app = page.frameLocator("#app");
    try {
      await app
        .locator("#count")
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const frame = page.frames().find((entry) => entry.name() === "app");
      const body = frame
        ? await frame.locator("body").textContent()
        : undefined;
      const hostState = await readHostState(page);
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `app body: ${body ?? "<missing>"}`,
          `host state: ${JSON.stringify(hostState)}`,
          `page errors: ${JSON.stringify(pageErrors)}`,
          `console: ${JSON.stringify(consoleMessages)}`,
        ].join("\n"),
      );
    }
    assert.equal(await app.locator("#count").textContent(), "Count=0");
    assert.equal(
      await app
        .locator("#renderify-mcp-root")
        .getAttribute("data-renderify-status"),
      "ready",
    );
    let listenerStats = await readListenerStats(app);
    assert.equal(listenerStats.added.click, 1);
    assert.equal(listenerStats.removed.click ?? 0, 0);

    const initialized = await readHostState(page);
    assert.equal(initialized.initialized, 1);
    assert.equal(initialized.appInfo?.name, "@renderify/mcp-app");
    assert.match(initialized.appInfo?.version ?? "", /^\d+\.\d+\.\d+/);

    const attacker = page.frames().find((frame) => frame.name() === "attacker");
    assert.ok(attacker);
    await attacker.evaluate((result) => {
      const target =
        window.parent.document.querySelector<HTMLIFrameElement>("#app");
      target?.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: result,
        },
        "*",
      );
    }, spoofedResult);
    await page.waitForTimeout(150);
    assert.equal(await app.getByText("SPOOFED RESULT").count(), 0);
    assert.equal(await app.locator("#count").textContent(), "Count=0");

    await app.locator("#increment").click();
    await app
      .getByText("Count=1", { exact: true })
      .waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const state = (
        globalThis as unknown as { __mcpHostState?: BrowserHostState }
      ).__mcpHostState;
      return state?.modelContexts.some((entry) =>
        JSON.stringify(entry).includes('"count":1'),
      );
    });

    await app.locator("#blocked-tool").click();
    await page.waitForTimeout(100);
    let state = await readHostState(page);
    assert.equal(state.toolCalls.length, 0);
    assert.equal(
      await app
        .locator("#renderify-mcp-root")
        .getAttribute("data-renderify-tool-error"),
      "disallowed",
    );

    await app.locator("#refresh").click();
    await app.getByText("Refreshed safely").waitFor({ state: "visible" });
    state = await readHostState(page);
    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.toolCalls[0]?.name, "refresh_dashboard");
    assert.deepEqual(state.toolCalls[0]?.arguments, { source: "mcp-app" });
    listenerStats = await readListenerStats(app);
    assert.equal(listenerStats.added.click, 1);
    assert.equal(listenerStats.removed.click ?? 0, 0);

    await app.locator("#same-refresh").click();
    await page.waitForFunction(() => {
      const hostState = (
        globalThis as unknown as { __mcpHostState?: BrowserHostState }
      ).__mcpHostState;
      return hostState?.toolCalls.length === 2;
    });
    await app.getByText("Refreshed safely").waitFor({ state: "visible" });
    assert.equal(await app.locator("#same-refresh").count(), 1);
    listenerStats = await readListenerStats(app);
    assert.equal(listenerStats.added.click, 1);
    assert.equal(listenerStats.removed.click ?? 0, 0);

    await app.locator("#error-refresh").click();
    await page.waitForFunction(() => {
      const hostState = (
        globalThis as unknown as { __mcpHostState?: BrowserHostState }
      ).__mcpHostState;
      return hostState?.toolCalls.length === 3;
    });
    await app
      .locator('#renderify-mcp-root[data-renderify-tool-error="call-failed"]')
      .waitFor({ state: "attached" });
    assert.equal(await app.getByText("ERROR PLAN RENDERED").count(), 0);
    assert.equal(await app.getByText("Refreshed safely").count(), 1);

    await app.locator("#deferred-refresh").click();
    await page.waitForFunction(() => {
      const hostState = (
        globalThis as unknown as { __mcpHostState?: BrowserHostState }
      ).__mcpHostState;
      return hostState?.toolCalls.length === 4;
    });

    await page.evaluate(async () => {
      const target = globalThis as unknown as {
        __mcpBridge: BrowserBridge;
        __mcpHostState: BrowserHostState;
      };
      target.__mcpHostState.teardownResult =
        await target.__mcpBridge.teardownResource({});
    });
    await app
      .locator('#renderify-mcp-root[data-renderify-status="terminated"]')
      .waitFor({ state: "attached" });
    state = await readHostState(page);
    assert.deepEqual(state.teardownResult, {});
    await page.evaluate(() => {
      (
        globalThis as unknown as { __resolvePendingMcpTool: () => void }
      ).__resolvePendingMcpTool();
    });
    await page.waitForTimeout(150);
    assert.equal(await app.getByText("LATE RESULT").count(), 0);
    assert.equal(
      await app
        .locator("#renderify-mcp-root")
        .getAttribute("data-renderify-status"),
      "terminated",
    );
    listenerStats = await readListenerStats(app);
    assert.equal(listenerStats.added.click, 1);
    assert.equal(listenerStats.removed.click, 1);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test("e2e: rejected replacement plans release delegated listeners", async () => {
  const hostBundle = await bundleOfficialHostBridge();
  const viewBundle = await bundleRenderifyMcpView();
  const shell = await createRenderifyShell({
    browserBundle: instrumentMountListeners(viewBundle.code),
    allowedTools: ["replace_view"],
  });
  const initialResult = asBrowserToolResult(
    renderifyToolResult(
      planPayload({
        specVersion: "runtime-plan/v1",
        id: "replacement_source",
        version: 1,
        capabilities: { domWrite: true },
        root: {
          type: "element",
          tag: "button",
          props: {
            id: "replace-view",
            type: "button",
            onClick: "tool:replace_view",
          },
          children: [{ type: "text", value: "Replace view" }],
        },
      }),
    ),
  );
  const rejectedResult = asBrowserToolResult(
    renderifyToolResult(planPayload(createOverDepthPlan())),
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.setContent('<iframe id="app" sandbox="allow-scripts"></iframe>');
    await page.addScriptTag({ content: hostBundle });
    await page.evaluate(
      async ({ shellHtml, firstResult, nextResult }) => {
        const hostModule = (
          globalThis as unknown as { McpAppsHost: BrowserHostModule }
        ).McpAppsHost;
        const iframe = document.querySelector<HTMLIFrameElement>("#app");
        if (!iframe?.contentWindow) {
          throw new Error("MCP App iframe is unavailable");
        }

        const bridge = new hostModule.AppBridge(
          null,
          { name: "Renderify rejection host", version: "1.0.0" },
          {
            serverTools: {},
            updateModelContext: { structuredContent: {} },
          },
        );
        bridge.onupdatemodelcontext = async () => ({});
        bridge.oncalltool = async () => nextResult;
        bridge.oninitialized = () => {
          void bridge.sendToolResult(firstResult);
        };
        await bridge.connect(
          new hostModule.PostMessageTransport(
            iframe.contentWindow,
            iframe.contentWindow,
          ),
        );
        iframe.srcdoc = shellHtml;
      },
      {
        shellHtml: shell.html,
        firstResult: initialResult,
        nextResult: rejectedResult,
      },
    );

    const app = page.frameLocator("#app");
    await app.locator("#replace-view").click();
    await app
      .locator('#renderify-mcp-root[data-renderify-status="error"]')
      .waitFor({ state: "attached" });
    assert.equal(
      await app.locator("#renderify-mcp-root").textContent(),
      "This interactive view was rejected by its security policy.",
    );
    const listenerStats = await readListenerStats(app);
    assert.equal(listenerStats.added.click, 1);
    assert.equal(listenerStats.removed.click, 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test("e2e: HTTP srcdoc rejects inherited-base fragment navigation", async () => {
  const hostBundle = await bundleOfficialHostBridge();
  const viewBundle = await bundleRenderifyMcpView();
  const shell = await createRenderifyShell({ browserBundle: viewBundle.code });
  const rejectedResult = asBrowserToolResult({
    content: [{ type: "text", text: "Unsafe fragment navigation" }],
    structuredContent: {
      renderify: { plan: createFragmentNavigationPlan() },
    },
  });

  const hostRequests: string[] = [];
  const server = createServer((request, response) => {
    hostRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><iframe id="app" name="app" sandbox="allow-scripts"></iframe>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${address.port}/host`);
    await page.addScriptTag({ content: hostBundle });
    hostRequests.length = 0;
    externalRequests.length = 0;

    await page.evaluate(
      async ({ shellHtml, result }) => {
        const hostModule = (
          globalThis as unknown as { McpAppsHost: BrowserHostModule }
        ).McpAppsHost;
        const iframe = document.querySelector<HTMLIFrameElement>("#app");
        if (!iframe?.contentWindow) {
          throw new Error("MCP App iframe is unavailable");
        }

        const bridge = new hostModule.AppBridge(
          null,
          { name: "Renderify HTTP host", version: "1.0.0" },
          { updateModelContext: { structuredContent: {} } },
        );
        bridge.onupdatemodelcontext = async () => ({});
        bridge.oninitialized = () => {
          void bridge.sendToolResult(result);
        };
        await bridge.connect(
          new hostModule.PostMessageTransport(
            iframe.contentWindow,
            iframe.contentWindow,
          ),
        );
        iframe.srcdoc = shellHtml;
      },
      { shellHtml: shell.html, result: rejectedResult },
    );

    const app = page.frameLocator("#app");
    await app
      .locator('#renderify-mcp-root[data-renderify-status="error"]')
      .waitFor({ state: "attached" });
    assert.equal(await app.locator("#fragment-navigation").count(), 0);
    assert.equal(
      await app.locator("#renderify-mcp-root").textContent(),
      "This interactive view was rejected by its security policy.",
    );
    assert.equal(
      page
        .frames()
        .find((frame) => frame.name() === "app")
        ?.url(),
      "about:srcdoc",
    );
    assert.deepEqual(hostRequests, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function bundleOfficialHostBridge(): Promise<string> {
  const result = await build({
    stdin: {
      contents:
        'export { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";',
      resolveDir: process.cwd(),
      sourcefile: "mcp-app-conformance-host.mjs",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "McpAppsHost",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
  });
  const code = result.outputFiles?.[0]?.text;
  assert.ok(code);
  return code;
}

function instrumentMountListeners(bundle: string): string {
  const instrumentation = `globalThis.__renderifyListenerStats={added:{},removed:{}};(function(){var add=EventTarget.prototype.addEventListener;var remove=EventTarget.prototype.removeEventListener;EventTarget.prototype.addEventListener=function(type){if(this&&this.id==="renderify-mcp-root"){var stats=globalThis.__renderifyListenerStats.added;stats[type]=(stats[type]||0)+1;}return add.apply(this,arguments);};EventTarget.prototype.removeEventListener=function(type){if(this&&this.id==="renderify-mcp-root"){var stats=globalThis.__renderifyListenerStats.removed;stats[type]=(stats[type]||0)+1;}return remove.apply(this,arguments);};})();`;
  return `${instrumentation}${bundle}`;
}

function asBrowserToolResult(value: unknown): BrowserToolResult {
  return JSON.parse(JSON.stringify(value)) as BrowserToolResult;
}

async function readHostState(
  page: import("playwright").Page,
): Promise<BrowserHostState> {
  return page.evaluate(() => {
    const state = (
      globalThis as unknown as { __mcpHostState?: BrowserHostState }
    ).__mcpHostState;
    if (!state) {
      throw new Error("MCP host state is unavailable");
    }
    return structuredClone(state);
  });
}

async function readListenerStats(
  app: import("playwright").FrameLocator,
): Promise<BrowserListenerStats> {
  return app.locator("body").evaluate(() => {
    const stats = (
      globalThis as unknown as {
        __renderifyListenerStats?: BrowserListenerStats;
      }
    ).__renderifyListenerStats;
    if (!stats) {
      throw new Error("MCP listener stats are unavailable");
    }
    return structuredClone(stats);
  });
}
