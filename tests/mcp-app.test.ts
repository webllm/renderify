import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildCspDirectives,
  buildCspString,
  buildModelContextParams,
  buildRenderifyShellHtml,
  buildResourceCspDomains,
  buildShellBridgeScript,
  buildUiResourceUri,
  createRenderifyShell,
  createRenderifyUiResource,
  DEFAULT_TOOL_EVENT_PREFIX,
  isUiResourceUri,
  MCP_UI_EXTENSION_ID,
  MCP_UI_HOST_NOTIFICATIONS,
  MCP_UI_HTML_MIME_TYPE,
  MCP_UI_VIEW_METHODS,
  planPayload,
  registerRenderifyApp,
  renderifyToolMeta,
  renderifyToolResult,
  serializeCsp,
  sourcePayload,
  toolCallFromEvent,
} from "@renderify/mcp-app";

test("protocol: constants match the SEP-1865 literals", () => {
  assert.equal(MCP_UI_EXTENSION_ID, "io.modelcontextprotocol/ui");
  assert.equal(MCP_UI_HTML_MIME_TYPE, "text/html;profile=mcp-app");
  assert.equal(
    MCP_UI_HOST_NOTIFICATIONS.toolResult,
    "ui/notifications/tool-result",
  );
  assert.equal(
    MCP_UI_VIEW_METHODS.updateModelContext,
    "ui/update-model-context",
  );
});

test("protocol: ui:// uri building + validation", () => {
  assert.equal(buildUiResourceUri("srv", "panel"), "ui://srv/panel");
  assert.equal(buildUiResourceUri("ui://srv/", "/panel"), "ui://srv/panel");
  assert.ok(isUiResourceUri("ui://srv/panel"));
  assert.ok(!isUiResourceUri("https://srv/panel"));
  assert.ok(!isUiResourceUri("ui://"));
});

test("csp: self-contained declarative has no module/transpiler domains", () => {
  const directives = buildCspDirectives({ mode: "self-contained" });
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["connect-src"], ["'none'"]);
  assert.ok(directives["script-src"].includes("'self'"));
  assert.ok(directives["script-src"].includes("blob:"));
  assert.ok(directives["worker-src"].includes("blob:"));
  // No JSPM/CDN egress in the self-contained declarative tier.
  assert.ok(!directives["connect-src"].some((s) => s.startsWith("https://")));
});

test("csp: blob: can be disabled (declarative-only, strictest)", () => {
  const directives = buildCspDirectives({
    mode: "self-contained",
    allowBlobModules: false,
  });
  assert.ok(!directives["script-src"].includes("blob:"));
  assert.deepEqual(directives["worker-src"], ["'none'"]);
});

test("csp: declared-domains threads module + transpiler origins", () => {
  const options = {
    mode: "declared-domains" as const,
    moduleDomains: ["https://ga.jspm.io", "https://cdn.jspm.io"],
    transpilerDomains: ["https://unpkg.com"],
  };
  const directives = buildCspDirectives(options);
  assert.ok(directives["connect-src"].includes("https://ga.jspm.io"));
  assert.ok(directives["script-src"].includes("https://unpkg.com"));

  const domains = buildResourceCspDomains(options);
  assert.deepEqual(domains.connectDomains, [
    "https://ga.jspm.io",
    "https://cdn.jspm.io",
  ]);
  assert.ok(domains.resourceDomains?.includes("https://unpkg.com"));
  // Keyword sources never leak into the host-facing domain lists.
  assert.ok(!domains.connectDomains?.some((d) => d.startsWith("'")));
});

test("csp: serialize round-trips directive map to a policy string", () => {
  const str = buildCspString({ mode: "self-contained" });
  assert.ok(str.includes("default-src 'none'"));
  assert.ok(str.includes("; script-src "));
  assert.equal(
    serializeCsp({ "default-src": ["'none'"] }),
    "default-src 'none'",
  );
});

test("bridge: config is baked into an IIFE referencing the right methods", () => {
  const script = buildShellBridgeScript({
    mountId: "renderify-root",
    securityProfile: "trusted",
    autoPinModules: false,
    toolEventPrefix: DEFAULT_TOOL_EVENT_PREFIX,
    methods: {
      initialize: MCP_UI_VIEW_METHODS.initialize,
      updateModelContext: MCP_UI_VIEW_METHODS.updateModelContext,
      toolsCall: "tools/call",
      toolResult: MCP_UI_HOST_NOTIFICATIONS.toolResult,
      toolInput: MCP_UI_HOST_NOTIFICATIONS.toolInput,
      resourceTeardown: MCP_UI_HOST_NOTIFICATIONS.resourceTeardown,
      requestTeardown: "ui/notifications/request-teardown",
      notifyMessage: "notifications/message",
    },
    debug: false,
  });
  assert.ok(script.startsWith("(function(){var RENDERIFY_SHELL_CONFIG="));
  assert.ok(script.includes("ui/notifications/tool-result"));
  assert.ok(script.includes("createInteractiveSession"));
  assert.ok(script.includes("__renderifyRuntimeReady"));
});

test("event-bridge: tool: prefixed events map to tools/call intents", () => {
  const intent = toolCallFromEvent({
    type: "tool:refresh",
    payload: { id: "x" },
  });
  assert.deepEqual(intent, { name: "refresh", arguments: { id: "x" } });
  assert.equal(toolCallFromEvent({ type: "click" }), undefined);
  assert.equal(toolCallFromEvent({ type: "tool:" }), undefined);
});

test("event-bridge: model context params carry plan id + state + event", () => {
  const params = buildModelContextParams({
    planId: "p1",
    state: { count: 2 },
    event: { type: "increment", payload: { by: 1 } },
  });
  assert.equal(params.context.planId, "p1");
  assert.deepEqual(params.context.state, { count: 2 });
  assert.deepEqual(params.context.lastEvent, {
    type: "increment",
    payload: { by: 1 },
  });
});

test("template: pure builder embeds csp, loader, bridge in order", () => {
  const html = buildRenderifyShellHtml({
    csp: "default-src 'none'",
    runtimeLoader: { inlineBundle: "globalThis.RenderifyRuntime={};" },
    bridgeScript: "/*bridge*/",
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(html.includes("__renderifyRuntimeReady"));
  const bundleIdx = html.indexOf("RenderifyRuntime");
  const bridgeIdx = html.indexOf("/*bridge*/");
  assert.ok(bundleIdx > 0 && bridgeIdx > bundleIdx, "loader precedes bridge");
});

test("template: declared-domains loader emits importmap + module script", () => {
  const html = buildRenderifyShellHtml({
    csp: "default-src 'none'",
    runtimeLoader: {
      moduleSpecifier: "@renderify/runtime",
      importmap: '{"imports":{"@renderify/runtime":"https://esm.sh/x"}}',
    },
    bridgeScript: "/*bridge*/",
  });
  assert.ok(html.includes('<script type="importmap">'));
  assert.ok(html.includes('<script type="module">'));
  assert.ok(html.includes("import * as RenderifyRuntime"));
});

test("shell: self-contained inlines runtime + hash CSP drops unsafe-inline", async () => {
  const shell = await createRenderifyShell({
    mode: "self-contained",
    runtimeEntry: "@renderify/runtime",
    resolveDir: process.cwd(),
    useScriptHashes: true,
  });
  assert.equal(shell.mode, "self-contained");
  assert.ok(shell.html.includes("RenderifyRuntime"));
  assert.match(shell.csp, /script-src[^;]*sha256-/);
  assert.doesNotMatch(shell.csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(shell.csp, /connect-src 'none'/);

  // Every inline script's hash must actually be present in the policy.
  const inlineScripts = [
    ...shell.html.matchAll(/<script(?:\s+type="[^"]*")?>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  assert.ok(inlineScripts.length >= 3);
  for (const code of inlineScripts) {
    const hash = createHash("sha256").update(code, "utf8").digest("base64");
    assert.ok(
      shell.csp.includes(`'sha256-${hash}'`),
      "inline script hash missing from CSP",
    );
  }
});

test("shell: declared-domains requires a module specifier", async () => {
  await assert.rejects(
    () => createRenderifyShell({ mode: "declared-domains" }),
    /runtimeModuleSpecifier/,
  );
});

test("server: tool result carries the renderify payload contract", () => {
  const plan = {
    specVersion: "runtime-plan/v1",
    id: "p1",
    version: 1,
    root: { type: "text" as const, value: "hi" },
  };
  const result = renderifyToolResult(planPayload(plan));
  assert.deepEqual(result.structuredContent.renderify, { plan });
  assert.equal(result.content[0].type, "text");

  const srcResult = renderifyToolResult(
    sourcePayload(
      { language: "tsx", code: "export default () => null;" },
      { id: "s1" },
    ),
  );
  assert.equal(
    (srcResult.structuredContent.renderify as { id?: string }).id,
    "s1",
  );
});

test("server: tool meta references the resource uri", () => {
  const meta = renderifyToolMeta("ui://srv/panel", { visibility: ["app"] });
  assert.equal(meta.ui.resourceUri, "ui://srv/panel");
  assert.deepEqual(meta.ui.visibility, ["app"]);
});

test("server: createRenderifyUiResource declares _meta.ui under both keys", async () => {
  const res = await createRenderifyUiResource({
    server: "demo",
    name: "panel",
    resolveDir: process.cwd(),
  });
  assert.equal(res.uri, "ui://demo/panel");
  assert.equal(res.mimeType, MCP_UI_HTML_MIME_TYPE);
  assert.ok(res._meta[MCP_UI_EXTENSION_ID]);
  assert.ok(res._meta.ui);
  assert.equal(res.contents[0].uri, res.uri);
  assert.ok(res.contents[0].text.includes("<!doctype html>"));
});

test("server: registerRenderifyApp wires resource + tool into an SDK server", async () => {
  const calls: { resources: unknown[]; tools: unknown[] } = {
    resources: [],
    tools: [],
  };
  const fakeServer = {
    registerResource: (...args: unknown[]) => calls.resources.push(args),
    registerTool: (...args: unknown[]) => calls.tools.push(args),
  };
  const resource = await registerRenderifyApp(fakeServer, {
    server: "demo",
    name: "panel",
    toolName: "render_dashboard",
    resolveDir: process.cwd(),
    handler: () =>
      planPayload({
        specVersion: "runtime-plan/v1",
        id: "p1",
        version: 1,
        root: { type: "text", value: "hi" },
      }),
  });
  assert.equal(calls.resources.length, 1);
  assert.equal(calls.tools.length, 1);
  const [toolName, toolConfig] = calls.tools[0] as [
    string,
    Record<string, unknown>,
  ];
  assert.equal(toolName, "render_dashboard");
  const toolMeta = toolConfig._meta as { ui: { resourceUri: string } };
  assert.equal(toolMeta.ui.resourceUri, resource.uri);

  // The registered tool handler returns a renderify tool result.
  const handler = (calls.tools[0] as unknown[])[2] as (
    a: unknown,
  ) => Promise<{ structuredContent: { renderify: unknown } }>;
  const out = await handler({});
  assert.ok(out.structuredContent.renderify);
});
