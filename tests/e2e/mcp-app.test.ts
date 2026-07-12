import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { RuntimePlan } from "../../packages/ir/src/index";
import {
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
            id: "deferred-refresh",
            type: "button",
            onClick: "tool:refresh_dashboard",
          },
          children: [{ type: "text", value: "Deferred refresh" }],
        },
      ],
    },
  };
}

test("e2e: official AppBridge drives the offline Renderify MCP App lifecycle", async () => {
  const hostBundle = await bundleOfficialHostBridge();
  const shell = await createRenderifyShell({
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
      }: {
        shellHtml: string;
        firstResult: BrowserToolResult;
        nextResult: BrowserToolResult;
        deferredResult: BrowserToolResult;
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
          if (state.toolCalls.length > 1) {
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

    await app.locator("#deferred-refresh").click();
    await page.waitForFunction(() => {
      const hostState = (
        globalThis as unknown as { __mcpHostState?: BrowserHostState }
      ).__mcpHostState;
      return hostState?.toolCalls.length === 2;
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
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
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
