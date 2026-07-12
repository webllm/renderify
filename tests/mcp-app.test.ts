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
  bundleRenderifyMcpView,
  createRenderifyShell,
  createRenderifyUiResource,
  DeclarativeMcpPlanError,
  extractRenderifyPlan,
  MCP_UI_EXTENSION_ID,
  parseDeclarativeMcpPlan,
  planPayload,
  type RenderifyToolHandlerExtra,
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
      name: "control-obfuscated mail navigation URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "a",
          props: { href: "mai\nlto:leak@example.com" },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "control-obfuscated telephone navigation URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "a",
          props: { href: "te\tl:+12025550123" },
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
      name: "CSS image-set URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "rect",
          props: {
            cursor: 'image-set("https://evil.example/cursor.png" 1x), auto',
          },
        };
      },
      code: "NETWORK_DISABLED",
    },
    {
      name: "obfuscated CSS image-set URL",
      mutate: (plan) => {
        plan.root = {
          type: "element",
          tag: "rect",
          props: {
            cursor: 'image-s\\65 t("https://evil.example/cursor.png" 1x), auto',
          },
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
    tag: "svg",
    children: [
      {
        type: "element",
        tag: "use",
        props: { href: "#shape" },
      },
      {
        type: "element",
        tag: "linearGradient",
        props: { "xlink:href": "#base-gradient" },
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

test("mcp-app rejects runtime templates in URL-bearing attributes", () => {
  const cases = [
    "{{state.cursor}}, auto",
    "u{{state.functionMiddle}}l(/cursor), auto",
    "url(#{{state.paintServer}})",
  ];

  for (const cursor of cases) {
    const plan = createPlan();
    plan.state = {
      initial: {
        cursor: "url(/cursor)",
        functionMiddle: "r",
        paintServer: "gradient",
      },
    };
    plan.root = {
      type: "element",
      tag: "rect",
      props: { cursor },
    };

    assert.throws(
      () => parseDeclarativeMcpPlan(plan),
      (error: unknown) =>
        error instanceof DeclarativeMcpPlanError &&
        error.code === "NETWORK_DISABLED",
      cursor,
    );
  }
});

test("mcp-app permits runtime templates outside URL-bearing attributes", () => {
  const plan = createPlan();
  plan.state = { initial: { label: "Offline dashboard" } };
  plan.root = {
    type: "element",
    tag: "section",
    props: {
      class: "dashboard-{{state.label}}",
      title: "{{state.label}}",
    },
    children: [{ type: "text", value: "{{state.label}}" }],
  };

  assert.doesNotThrow(() => parseDeclarativeMcpPlan(plan));
});

test("mcp-app rejects fragment hrefs on navigation and resource elements", () => {
  const cases: Array<{ tag: string; attribute: string }> = [
    { tag: "a", attribute: "href" },
    { tag: "area", attribute: "href" },
    { tag: "image", attribute: "href" },
    { tag: "image", attribute: "xlink:href" },
  ];

  for (const fixture of cases) {
    const plan = createPlan();
    plan.root = {
      type: "element",
      tag: fixture.tag,
      props: { [fixture.attribute]: "#inherited-base-target" },
    };

    assert.throws(
      () => parseDeclarativeMcpPlan(plan),
      (error: unknown) =>
        error instanceof DeclarativeMcpPlanError &&
        error.code === "NETWORK_DISABLED",
      `${fixture.tag} ${fixture.attribute}`,
    );
  }
});

test("mcp-app rejects browser-managed SVG animation and mutation elements", () => {
  for (const tag of [
    "animate",
    "animateColor",
    "animateMotion",
    "animateTransform",
    "discard",
    "set",
  ]) {
    const plan = createPlan();
    plan.root = {
      type: "element",
      tag: "svg",
      children: [
        {
          type: "element",
          tag,
          props: {
            attributeName: "href",
            to: "https://evil.example/leak",
            begin: "0s",
            fill: "freeze",
          },
        },
      ],
    };

    assert.throws(
      () => parseDeclarativeMcpPlan(plan),
      (error: unknown) =>
        error instanceof DeclarativeMcpPlanError &&
        error.code === "TIMERS_DISABLED",
      tag,
    );
  }
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

test("mcp-app shell normalizes provided browser bundles before hashing", async () => {
  const browserBundle =
    "globalThis.RenderifyMcpApp={\r\nstartRenderifyMcpApp:async()=>{}\r};\r\n";
  const normalizedBundle = browserBundle.replace(/\r\n?/g, "\n");
  const shell = await createRenderifyShell({ browserBundle });
  const scripts = [...shell.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );

  assert.equal(scripts[0], normalizedBundle);
  assert.equal(shell.bundleBytes, Buffer.byteLength(normalizedBundle, "utf8"));
  assert.doesNotMatch(shell.html, /\r/);
  const hash = createHash("sha256")
    .update(normalizedBundle, "utf8")
    .digest("base64");
  assert.ok(shell.csp.includes(`'sha256-${hash}'`));

  await assert.rejects(
    () => createRenderifyShell({ browserBundle: "" }),
    /browserBundle must not be empty/,
  );
  await assert.rejects(
    () => createRenderifyShell({ browserBundle: "\r\n\t" }),
    /browserBundle must not be empty/,
  );
  await assert.rejects(
    () =>
      createRenderifyShell({
        browserBundle:
          "globalThis.beforeNull=true;/*\u0000*/globalThis.afterNull=true;",
      }),
    /browserBundle must not contain null characters/,
  );
});

test("mcp-app bundler resolves relative view entries from its base directory", async () => {
  const bundles = await Promise.all([
    bundleRenderifyMcpView({
      viewEntry: "./packages/mcp-app/src/view.ts",
    }),
    bundleRenderifyMcpView({
      viewEntry: "./view.ts",
      resolveDir: "./packages/mcp-app/src",
    }),
  ]);

  for (const bundle of bundles) {
    assert.ok(bundle.bytes > 0);
    assert.equal(bundle.bytes, Buffer.byteLength(bundle.code, "utf8"));
    assert.match(bundle.code, /RenderifyMcpApp/);
  }
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
  let observedExtra: RenderifyToolHandlerExtra | undefined;
  let observedNoSchemaArgs: unknown;
  let observedNoSchemaExtra: RenderifyToolHandlerExtra | undefined;
  await registerRenderifyApp(server, {
    uri: "ui://renderify/dashboard",
    name: "Renderify dashboard",
    browserBundle:
      "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};",
    toolName: "show_dashboard",
    toolInputSchema: z.object({ label: z.string() }),
    handler: (args, extra) => {
      observedArgs = args;
      observedExtra = extra;
      const plan = createPlan();
      plan.metadata = { label: (args as { label: string }).label };
      return plan;
    },
  });
  await registerRenderifyApp(server, {
    uri: "ui://renderify/default-dashboard",
    name: "Default Renderify dashboard",
    browserBundle:
      "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};",
    toolName: "show_default_dashboard",
    handler: (args, extra) => {
      observedNoSchemaArgs = args;
      observedNoSchemaExtra = extra;
      return createPlan();
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
    assert.ok(observedExtra);
    assert.ok(observedExtra.signal instanceof AbortSignal);
    assert.notEqual(observedExtra.requestId, undefined);
    assert.equal(typeof observedExtra.sendNotification, "function");
    assert.equal(extractRenderifyPlan(called)?.metadata?.label, "Quarterly");

    const calledWithoutSchema = await client.callTool({
      name: "show_default_dashboard",
    });
    assert.deepEqual(observedNoSchemaArgs, {});
    assert.ok(observedNoSchemaExtra);
    assert.ok(observedNoSchemaExtra.signal instanceof AbortSignal);
    assert.notEqual(observedNoSchemaExtra.requestId, undefined);
    assert.equal(typeof observedNoSchemaExtra.sendNotification, "function");
    assert.equal(
      extractRenderifyPlan(calledWithoutSchema)?.id,
      "mcp_unit_plan",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp-app rolls back its resource when tool registration fails", async () => {
  const server = new McpServer({
    name: "renderify-registration-test",
    version: "1.0.0",
  });
  const browserBundle =
    "globalThis.RenderifyMcpApp={startRenderifyMcpApp:async()=>{}};";
  await registerRenderifyApp(server, {
    uri: "ui://renderify/registered",
    name: "Registered Renderify app",
    browserBundle,
    toolName: "duplicate_tool",
    handler: () => createPlan(),
  });

  await assert.rejects(
    () =>
      registerRenderifyApp(server, {
        uri: "ui://renderify/orphaned",
        name: "Orphaned Renderify app",
        browserBundle,
        toolName: "duplicate_tool",
        handler: () => createPlan(),
      }),
    /already registered/,
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "registration-test-client",
    version: "1.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    assert.deepEqual(
      (await client.listResources()).resources.map((entry) => entry.uri),
      ["ui://renderify/registered"],
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((entry) => entry.name),
      ["duplicate_tool"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});
