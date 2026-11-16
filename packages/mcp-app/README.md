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
- Optionally (`sourceMode: true`) render model-written JSX or TSX in a
  sandboxed frame nested inside the view.

## Not responsible for

- Executing JSX, TSX, JavaScript, or TypeScript from a tool result, unless the
  app opts into source mode; even then, never in the view's own window.
- Loading component modules, package imports, CDNs, or remote assets outside
  source mode.
- Authorizing server tool calls. The MCP server remains responsible for input
  validation, authentication, authorization, and side-effect confirmation.
- Creating the host iframe or its sandbox flags. MCP hosts own that boundary.

## Install

```bash
pnpm add @renderify/mcp-app @modelcontextprotocol/server zod
```

## Quick start

```ts
import { McpServer } from "@modelcontextprotocol/server";
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

The event payload becomes the tool arguments. It can carry what the user
entered: a `form` with `onSubmit: "tool:search_flights"` sends its named
fields (`{ "from": "SFO", "to": "JFK" }`), and payload values such as
`{ "$from": "state.query" }` read state bound with `bind` at the moment of the
click. Password and file inputs are never included. Typing into bound inputs
updates the model context once typing pauses rather than on every keystroke.

## Source mode

Plans cover forms, lists, and tables. For UIs that need npm libraries or custom
components, register the app with `sourceMode: true` and return source:

```ts
await registerRenderifyApp(server, {
  uri: "ui://charts/main",
  name: "Charts",
  toolName: "show_chart",
  sourceMode: true,
  allowedTools: ["save_chart"],
  handler: () => ({
    source: {
      language: "tsx",
      code: `
        import { useState } from "preact/hooks";
        export default function App() {
          const [title, setTitle] = useState("Q3");
          return (
            <form onSubmit={(event) => {
              event.preventDefault();
              window.renderify.action("tool:save_chart", { title });
            }}>
              <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
              <button>Save</button>
            </form>
          );
        }`,
    },
  }),
});
```

The view never runs that code itself. It renders it in a nested
`@renderify/frame` (an opaque-origin `sandbox="allow-scripts"` iframe), which
reaches your server only through `window.renderify.action("tool:<name>", args)`
for tools in `allowedTools`. If a tool returns another plan or source, the view
renders that next. `renderifySourceResult({ source })` builds such results in
custom flows.

What opting in changes:

- The resource inlines the frame runner (about 2.6 MB) and its view CSP allows
  that script by hash, plus `blob:` and the module CDNs (JSPM and esm.sh by
  default; set `moduleOrigins`). There is still no `unsafe-eval`.
- `_meta.ui.csp` declares those CDNs in `connectDomains` and
  `resourceDomains`. Hosts must honor them, allow `blob:` scripts, and allow
  `srcdoc` frames, as the ext-apps reference host does; on other hosts the view
  shows an error for source while plans keep working.
- Code in the frame can send anything it was given to the declared CDNs, so do
  not put secrets in source payloads or in results rendered with them.
- The model context only records that a source view is showing
  (`{ view: "source", framework }`); its state stays in the frame. Source is
  limited to 256 KiB (`maxSourceBytes`).

Source mode has been tested with the official `AppBridge` and the reference
host's CSP, not yet on production hosts. See
[ADR-0002](https://github.com/webllm/renderify/blob/main/docs/adr/0002-sandboxed-source-frame.md#mcp-source-mode).

## Public API

- `registerRenderifyApp` composes one tool and one resource.
- Registration is atomic from the helper's perspective: if tool registration
  fails, its resource registration is removed before the error is rethrown.
- Its handler receives the parsed arguments plus the official MCP SDK v2
  `ServerContext`: `mcpReq.signal` for cancellation, `mcpReq.id`, `sessionId`,
  and `http?.authInfo` for transport authentication.
- `MCP_UI_EXTENSION_ID`, `RESOURCE_MIME_TYPE`, and `getUiCapability` re-export
  the official capability-negotiation helpers.
- `createRenderifyUiResource`, `createRenderifyShell`, `renderifyToolMeta`,
  `renderifyToolResult`, and `renderifySourceResult` support custom
  registration flows.
- `parseDeclarativeMcpPlan` enforces the offline plan contract;
  `parseMcpSource` and `readRenderifyPayloadFromToolResult` validate source
  payloads for source-mode apps.
- `bundleRenderifyMcpView` emits the self-contained browser IIFE. Relative
  `viewEntry` paths resolve from `resolveDir`, or the current working directory
  when `resolveDir` is omitted.
- The `@renderify/mcp-app/view` export exposes the view entry for custom bundlers.

## Dependency limits

The package depends on `@renderify/ir`, `@renderify/security`,
`@renderify/runtime`, `@renderify/frame`, the official MCP Apps SDK, and
`esbuild` for server-side shell bundling. The browser view MUST NOT run source
in its own window or load external modules outside source mode; changing that
requires a new security decision and threat-model update.

The maintained security rationale is documented in
[ADR-0001](https://github.com/webllm/renderify/blob/main/docs/adr/0001-offline-declarative-mcp-app-boundary.md)
and the
[Renderify threat model](https://github.com/webllm/renderify/blob/main/docs/threat-model.md).

## Common wrong implementations

- Do not pass `plan.source`, component nodes, imports, or module manifests;
  return `{ source }` from a source-mode app instead.
- Do not add CSP domains to make a rejected plan work.
- Do not expose an app-callable tool without server-side authorization.
- Do not replace `PostMessageTransport` with an unvalidated `message` listener.
- Do not enable `sourceMode` to work around a rejected plan, or add tools to
  `allowedTools` that source must not reach.
