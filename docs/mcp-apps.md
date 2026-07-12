# Renderify × MCP Apps (`@renderify/mcp-app`)

MCP Apps (SEP-1865, extension id `io.modelcontextprotocol/ui`) standardizes the
**envelope** for interactive UI in MCP clients: a predeclared `ui://` resource
rendered in a sandboxed iframe, communicating with the host over the MCP JSON-RPC
base protocol carried on `postMessage`. The extension is intentionally **agnostic
about how the UI is produced** — from predefined templates, to declarative JSON
renderers, all the way to fully generative UI.

`@renderify/mcp-app` fills the **generative** slot. The standard defines the
envelope; it does not solve the hard part of the "fully generative" tier — how to
safely execute arbitrary model-generated TSX/JSON at runtime with no build step.
That is exactly what the Renderify runtime does, so this package adapts it to be
the reference runtime for that tier.

## The core idea: code as data into a pre-audited shell

```
register once:  ui://server/panel  →  a STATIC Renderify "shell" document
                                       (host can review + cache it)

per tool call:  tools/call → result.structuredContent.renderify = { plan | source }
                                       │
                          ui/notifications/tool-result (postMessage)
                                       ▼
                       shell's embedded runtime executes it → UI
```

The shell HTML never changes per call, so a host reviews it once. The model's UI
travels as **data** inside tool results and is executed by the shell's runtime
under the host's CSP. Interaction flows back as MCP messages: state →
`ui/update-model-context`, and `tool:`-prefixed events → `tools/call`.

## Quick start

```ts
import {
  bundleBrowserRuntime,
  registerRenderifyApp,
  planPayload,
} from "@renderify/mcp-app";

// Bundle the runtime once (self-contained tier; inlined into the shell).
const runtimeBundle = (await bundleBrowserRuntime()).code;

await registerRenderifyApp(mcpServer, {
  server: "my-server",
  name: "dashboard",
  mode: "self-contained",
  runtimeBundle,
  useScriptHashes: true, // strict CSP, no 'unsafe-inline'
  toolName: "render_dashboard",
  toolDescription: "Render an interactive dashboard.",
  handler: (args) => planPayload(buildPlan(args)), // model output goes here
});
```

`registerRenderifyApp` is sugar over framework-agnostic primitives you can wire
into any SDK by hand:

- `createRenderifyUiResource(opts)` → the shell HTML + `_meta.ui` (incl. CSP
  domains) + a `resources/read` `contents` array.
- `renderifyToolMeta(uri)` → the tool's `_meta.ui.resourceUri` binding.
- `renderifyToolResult(payload)` → a tool result carrying
  `structuredContent.renderify`.

A runnable example (stdio server + MCPJam instructions) lives in
[`examples/mcp-app/`](../examples/mcp-app/README.md).

## Delivery modes

| Mode | Runtime + deps | When |
| ---- | -------------- | ---- |
| `self-contained` | runtime inlined into the shell; no module CDN unless the plan declares bare imports | **Default for untrusted output.** Most host-portable; offline for declarative plans. |
| `declared-domains` | runtime + generated-code deps fetched from JSPM/CDN at runtime | Convenience tier; works only if the host honors the resource's declared CSP domains. |

## CSP feasibility — measured, not assumed

The biggest technical risk for an iframe-embedded generative runtime is the
**Content-Security-Policy** the host enforces. We validated it in real Chromium
(`tests/e2e/mcp-csp-feasibility.test.ts`). Findings:

| Tier | Payload | CSP needed | Network | Status |
| ---- | ------- | ---------- | ------- | ------ |
| **A** | Declarative `RuntimePlan` (RuntimeNode tree) | `default-src 'none'; script-src <hashes> blob:; style-src 'unsafe-inline'; connect-src 'none'` | none | ✅ **Renders fully offline under strict hash-based CSP.** Zero external requests, zero CSP violations, bridge round-trips. |
| **B** | TSX/JSX source, deps inlined/local | tier A **plus** a transpiler (`globalThis.Babel`) and module sources | none–same-origin | ⚠️ Needs a transpiler present and source deps provided locally. `script-src blob:` is **mandatory** (module execution uses blob-URL dynamic import). |
| **C** | TSX/JSX source + arbitrary npm via JSPM | `script-src 'self' blob: <jspm>; connect-src <jspm>` | JSPM/CDN | ⚠️ **At the host's mercy** — only works if the host allows the declared module domains. |

Two facts are load-bearing and proven by the suite:

1. **The declarative tier is fully self-contained and offline** under the
   strictest practical CSP, including hash-based `script-src` with no
   `'unsafe-inline'`. This is the always-works, safest path — prefer it for
   untrusted model output.
2. **`script-src blob:` is required** for any tier that executes transpiled
   source. A host that forbids `blob:` confines Renderify to the declarative
   tier (a safe degradation, not an escape).

### CSP knobs

`createRenderifyShell` / `createRenderifyUiResource` accept:

- `useScriptHashes: true` — emit `'sha256-…'` for each inline script and drop
  `'unsafe-inline'` (host-friendly; browsers ignore `'unsafe-inline'` when hashes
  are present anyway).
- `moduleDomains` / `transpilerDomains` — declared origins for the
  `declared-domains` tier; surfaced both in the document CSP and in the
  resource's `_meta.ui.csp` (`connectDomains` / `resourceDomains`) for the host.
- `localModules` — `{ specifier: browser-ESM source }`, injected as blob-URL
  manifest entries before render, to keep tier B offline for small deps.

## Security posture

The MCP Apps iframe sandbox + host CSP are **browser-enforced hard boundaries**,
independent of Renderify's own policy engine — which is why this is the
recommended deployment for untrusted output. See
[`docs/threat-model.md`](threat-model.md) §7 for how the embedding boundary
composes with Renderify's internal layers, and which generative tiers a host CSP
can restrict.

## Status & spec alignment

Tracks the `io.modelcontextprotocol/ui` extension toward the 2026-07-28
specification. Protocol constants (extension id, `ui://` scheme, notification and
method names, `text/html;profile=mcp-app` content type) live in
[`packages/mcp-app/src/protocol.ts`](../packages/mcp-app/src/protocol.ts) and are
unit-tested against the spec literals. As the RC settles, those constants are the
single place to update.
