import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  McpUiResourceMetaSchema,
  McpUiToolMetaSchema,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuntimePlan } from "../packages/ir/src/index";
import {
  createRenderifyShell,
  createRenderifyUiResource,
  DeclarativeMcpPlanError,
  extractRenderifyPlan,
  MCP_UI_EXTENSION_ID,
  parseDeclarativeMcpPlan,
  planPayload,
  registerRenderifyApp,
  renderifyToolMeta,
  renderifyToolResult,
} from "../packages/mcp-app/src/index";

function createPlan(): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "mcp_unit_plan",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "Offline dashboard" }],
    },
    state: {
      initial: { count: 0 },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  };
}

test("mcp-app accepts and detaches an offline declarative RuntimePlan", () => {
  const input = createPlan();
  const parsed = parseDeclarativeMcpPlan(input);

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.root, input.root);

  input.id = "mutated_after_validation";
  assert.equal(parsed.id, "mcp_unit_plan");
});

test("mcp-app rejects executable, remote, persistent, and oversized plans", () => {
  const cases: Array<{
    name: string;
    mutate: (plan: RuntimePlan) => void;
    code: DeclarativeMcpPlanError["code"];
  }> = [
    {
      name: "missing spec version",
      mutate: (plan) => {
        delete plan.specVersion;
      },
      code: "UNSUPPORTED_SPEC_VERSION",
    },
    {
      name: "runtime source",
      mutate: (plan) => {
        plan.source = { language: "js", code: "export default 1" };
      },
      code: "RUNTIME_SOURCE_DISABLED",
    },
    {
      name: "imports",
      mutate: (plan) => {
        plan.imports = ["https://evil.example/module.js"];
      },
      code: "REMOTE_MODULES_DISABLED",
    },
    {
      name: "component nodes",
      mutate: (plan) => {
        plan.root = { type: "component", module: "evil" };
      },
      code: "COMPONENT_NODES_DISABLED",
    },
    {
      name: "network",
      mutate: (plan) => {
        plan.capabilities = { networkHosts: ["evil.example"] };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "remote URL attribute",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "img",
          props: { src: "https://evil.example/collect" },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "external navigation URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "a",
          props: { href: "mailto:leak@example.com" },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "relative navigation URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "a",
          props: { href: "/leak?secret=runtime-state" },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "relative resource URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "img",
          props: { src: "./dashboard.png" },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "storage",
      mutate: (plan) => {
        plan.capabilities = { storage: ["localStorage"] };
      },
      code: "PERSISTENT_STORAGE_DISABLED",
    },
    {
      name: "timers",
      mutate: (plan) => {
        plan.capabilities = { timers: true };
      },
      code: "TIMERS_DISABLED",
    },
    {
      name: "sandbox profile",
      mutate: (plan) => {
        plan.capabilities = { executionProfile: "sandbox-worker" };
      },
      code: "EXECUTION_PROFILE_DISABLED",
    },
  ];

  for (const fixture of cases) {
    const plan = createPlan();
    fixture.mutate(plan);
    assert.throws(
      () => parseDeclarativeMcpPlan(plan),
      (error: unknown) =>
        error instanceof DeclarativeMcpPlanError && error.code === fixture.code,
      fixture.name,
    );
  }

  assert.throws(
    () => parseDeclarativeMcpPlan(createPlan(), { maxBytes: 10 }),
    (error: unknown) =>
      error instanceof DeclarativeMcpPlanError &&
      error.code === "PLAN_TOO_LARGE",
  );
});

test("mcp-app permits only non-network local fragment references", () => {
  const plan = createPlan();
  plan.root = {
    type: "element",
    tag: "section",
    children: [
      {
        type: "element",
        tag: "a",
        props: { href: "#details" },
        children: [{ type: "text", value: "Details" }],
      },
      {
        type: "element",
        tag: "path",
        props: { fill: "url(#gradient)" },
      },
    ],
  };

  assert.doesNotThrow(() => parseDeclarativeMcpPlan(plan));
});

test("mcp-app tool payload uses official structured content and validates on both sides", () => {
  assert.equal(MCP_UI_EXTENSION_ID, "io.modelcontextprotocol/ui");
  const result = renderifyToolResult(planPayload(createPlan()), {
    summary: "Dashboard ready.",
  });

  assert.equal(result.content[0]?.type, "text");
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : undefined,
    "Dashboard ready.",
  );
  assert.deepEqual(extractRenderifyPlan(result), createPlan());
  assert.deepEqual(renderifyToolMeta("ui://renderify/dashboard"), {
    ui: {
      resourceUri: "ui://renderify/dashboard",
      visibility: ["model"],
    },
  });
  assert.doesNotThrow(() =>
    McpUiToolMetaSchema.parse(renderifyToolMeta("ui://renderify/dashboard").ui),
  );
  assert.throws(() =>
    extractRenderifyPlan({
      structuredContent: { renderify: { source: "not allowed" } },
    }),
  );
});

test("mcp-app shell is self-contained and hashes every inline script", async () => {
  const shell = await createRenderifyShell({
    browserBundle:
      "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};",
    appName: '</script><script src="https://evil.example/x.js">',
    title: "<unsafe title>",
  });

  assert.match(shell.html, /&lt;unsafe title&gt;/);
  assert.doesNotMatch(shell.html, /src="https:\/\/evil\.example/);
  assert.doesNotMatch(shell.csp, /unsafe-eval/);
  assert.doesNotMatch(shell.csp, /script-src[^;]*unsafe-inline/);
  assert.deepEqual(shell.uiCsp, {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  });

  const scripts = [...shell.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    const hash = createHash("sha256").update(script, "utf8").digest("base64");
    assert.ok(shell.csp.includes(`'sha256-${hash}'`));
  }

  await assert.rejects(() =>
    createRenderifyShell({
      browserBundle: "globalThis.x='</script>';",
    }),
  );
});

test("mcp-app resource metadata declares no network or browser permissions", async () => {
  const resource = await createRenderifyUiResource({
    uri: "ui://renderify/dashboard",
    name: "Renderify dashboard",
    browserBundle:
      "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};",
  });

  assert.equal(resource.mimeType, RESOURCE_MIME_TYPE);
  assert.equal(resource.uri, "ui://renderify/dashboard");
  assert.deepEqual(resource.uiMeta.permissions, {});
  assert.doesNotThrow(() => McpUiResourceMetaSchema.parse(resource.uiMeta));
});

test("mcp-app registers interoperable tools and resources with the official SDK", async () => {
  const server = new McpServer({ name: "renderify-test", version: "1.0.0" });
  let observedArgs: unknown;
  await registerRenderifyApp(server, {
    uri: "ui://renderify/dashboard",
    name: "Renderify dashboard",
    browserBundle:
      "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};",
    toolName: "show_dashboard",
    toolInputSchema: z.object({ label: z.string() }),
    handler: (args) => {
      observedArgs = args;
      const plan = createPlan();
      plan.metadata = { label: (args as { label: string }).label };
      return plan;
    },
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "show_dashboard");
    assert.ok(tool);
    assert.equal(
      (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
      "ui://renderify/dashboard",
    );
    assert.equal(tool._meta?.["ui/resourceUri"], "ui://renderify/dashboard");

    const resources = await client.listResources();
    const resource = resources.resources.find(
      (entry) => entry.uri === "ui://renderify/dashboard",
    );
    assert.ok(resource);
    assert.doesNotThrow(() =>
      McpUiResourceMetaSchema.parse(
        (resource._meta?.ui as Record<string, unknown> | undefined) ?? {},
      ),
    );

    const read = await client.readResource({
      uri: "ui://renderify/dashboard",
    });
    assert.equal(read.contents[0]?.mimeType, RESOURCE_MIME_TYPE);
    const content = read.contents[0];
    assert.match(
      content && "text" in content ? String(content.text) : "",
      /Content-Security-Policy/,
    );

    const called = await client.callTool({
      name: "show_dashboard",
      arguments: { label: "Quarterly" },
    });
    assert.deepEqual(observedArgs, { label: "Quarterly" });
    assert.equal(extractRenderifyPlan(called)?.metadata?.label, "Quarterly");
  } finally {
    await client.close();
    await server.close();
  }
});
