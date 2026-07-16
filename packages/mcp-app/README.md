# @renderify/mcp-app

`@renderify/mcp-app` registers a self-contained `ui://` resource and carries a
Renderify plan in `structuredContent.renderify.plan`. It uses the official
`@modelcontextprotocol/ext-apps` bridge for initialization, notifications,
tool calls, model-context updates, sizing, and teardown.

## Responsibility

- Build a hash-CSP HTML shell with no external resource or connection domains.
- Register MCP Apps resources and tools through the official server helpers.
- Validate and detach every plan on both the server and view sides.
- Render local state transitions and optionally call explicitly allowlisted MCP
  tools.

## Not responsible for

- Executing JSX, TSX, JavaScript, or TypeScript from a tool result.
- Loading component modules, package imports, CDNs, or remote assets.
- Authorizing server tool calls. The MCP server remains responsible for input
  validation, authentication, authorization, and side-effect confirmation.
- Creating the host iframe or its sandbox flags. MCP hosts own that boundary.

## Install

```bash
pnpm add @renderify/mcp-app @modelcontextprotocol/sdk zod
```

## Quick start

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRenderifyApp } from "@renderify/mcp-app";
import { z } from "zod";

const server = new McpServer({ name: "dashboard", version: "1.0.0" });
const input = z.object({ title: z.string() });

await registerRenderifyApp(server, {
  uri: "ui://dashboard/main",
  name: "Dashboard",
  toolName: "show_dashboard",
  toolInputSchema: input,
  handler: (args) => {
    const { title } = input.parse(args);
    return {
      specVersion: "runtime-plan/v1",
      id: "dashboard",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "h2",
        children: [{ type: "text", value: title }],
      },
    };
  },
});
```

Use `allowedTools` only when a declarative event such as
`onClick: { type: "tool:update_item", payload: {...} }` must call back through
the host. The default allowlist is empty and the registered display tool is
model-only by default.

## Public API

- `registerRenderifyApp` composes one tool and one resource.
- Registration is atomic from the helper's perspective: if tool registration
  fails, its resource registration is removed before the error is rethrown.
- Its handler receives the parsed arguments plus the official MCP
  `RequestHandlerExtra`, including request cancellation, authentication,
  session, and transport context.
- `MCP_UI_EXTENSION_ID`, `RESOURCE_MIME_TYPE`, and `getUiCapability` re-export
  the official capability-negotiation helpers.
- `createRenderifyUiResource`, `createRenderifyShell`, `renderifyToolMeta`, and
  `renderifyToolResult` support custom registration flows.
- `parseDeclarativeMcpPlan` enforces the offline plan contract.
- `bundleRenderifyMcpView` emits the self-contained browser IIFE. Relative
  `viewEntry` paths resolve from `resolveDir`, or the current working directory
  when `resolveDir` is omitted.
- The `@renderify/mcp-app/view` export exposes the view entry for custom bundlers.

## Dependency limits

The package depends on `@renderify/ir`, `@renderify/security`,
`@renderify/runtime`, the official MCP Apps SDK, and `esbuild` for server-side
shell bundling. The browser view MUST NOT gain source execution or external
module loading without a new security decision and threat-model update.

The maintained security rationale is documented in
[ADR-0001](https://github.com/webllm/renderify/blob/main/docs/adr/0001-offline-declarative-mcp-app-boundary.md)
and the
[Renderify threat model](https://github.com/webllm/renderify/blob/main/docs/threat-model.md).

## Common wrong implementations

- Do not pass `plan.source`, component nodes, imports, or module manifests.
- Do not add CSP domains to make a rejected plan work.
- Do not expose an app-callable tool without server-side authorization.
- Do not replace `PostMessageTransport` with an unvalidated `message` listener.
