# Renderify MCP App example

This example registers one `show_dashboard` tool and one
`ui://renderify-example/dashboard` resource with the official MCP SDK. The view
is bundled into the resource at server startup and performs no network requests.

## Run

```bash
pnpm install
pnpm build
pnpm exec tsx examples/mcp-app/server.ts
```

Configure an MCP client to launch the final command over stdio, then call
`show_dashboard`. A client without MCP Apps support still receives the tool's
text summary.

## Boundary

The example accepts only `runtime-plan/v1` element/text trees. Runtime source,
component modules, imports, network access, timers, and persistent browser
storage are rejected before the result is sent and again inside the view.
