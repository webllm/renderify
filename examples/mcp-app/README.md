# Renderify × MCP Apps demo server

A runnable MCP server that exposes Renderify as **MCP Apps (SEP-1865) generative
UI**. It demonstrates the "code as data" model: a static, pre-auditable shell is
registered once as a `ui://` resource, and the model's UI travels in tool
results to be executed by the shell's embedded Renderify runtime.

## What it registers

| Kind     | Name / URI                          | Purpose                                                 |
| -------- | ----------------------------------- | ------------------------------------------------------- |
| Resource | `ui://renderify-demo/dashboard`     | The Renderify shell (self-contained, strict hash CSP).  |
| Tool     | `render_kpi_dashboard`              | Returns a RuntimePlan that renders into the resource.   |

The shell inlines the Renderify runtime and uses a hash-based
`Content-Security-Policy` (no `'unsafe-inline'`), so the dashboard renders with
**zero network access** inside the host's sandboxed iframe. This is the
"Tier A" generative path — see [`docs/mcp-apps.md`](../../docs/mcp-apps.md) for
the full CSP feasibility matrix and the source/TSX tiers.

## Run it

```bash
# From the repo root
pnpm add -D @modelcontextprotocol/sdk zod   # already dev-deps in this repo
pnpm exec tsx examples/mcp-app/server.ts
```

The server speaks MCP over **stdio** (JSON-RPC on stdout, logs on stderr).

## Drive it with MCPJam inspector

[MCPJam inspector](https://github.com/mcpjam/inspector) is an MCP Apps–capable
client, useful as a dev loop for UI resources.

```bash
npx @mcpjam/inspector
```

Then add a **stdio** server with:

- **Command:** `pnpm`
- **Args:** `exec tsx examples/mcp-app/server.ts`
- **CWD:** the repository root

Once connected:

1. Open **Tools**, select `render_kpi_dashboard`, optionally set `title`, and
   **Run**. The inspector renders the returned plan inside the
   `ui://renderify-demo/dashboard` iframe.
2. Open **Resources** to inspect the shell HTML and its declared `_meta.ui.csp`
   domains — this is exactly what a host reviews before trusting the shell.

> Any MCP Apps–capable host works the same way (the binding is in the tool's
> `_meta.ui.resourceUri`). MCPJam is just a convenient local inspector.

## How the wiring works

```ts
import { registerRenderifyApp, planPayload } from "@renderify/mcp-app";

await registerRenderifyApp(server, {
  server: "renderify-demo",
  name: "dashboard",
  mode: "self-contained",
  runtimeBundle,              // produced once via bundleBrowserRuntime()
  useScriptHashes: true,      // strict CSP, no 'unsafe-inline'
  toolName: "render_kpi_dashboard",
  handler: (args) => planPayload(buildDashboardPlan(args)),
});
```

`registerRenderifyApp` is a thin convenience over the framework-agnostic
building blocks (`createRenderifyUiResource`, `renderifyToolMeta`,
`renderifyToolResult`); you can wire those into any server SDK by hand.

## Files

- [`server.ts`](server.ts) — the MCP server (exported factory + stdio entry).
- [`dashboard-plan.ts`](dashboard-plan.ts) — builds the declarative RuntimePlan.
