---
type: test-plan
title: MCP Apps Test Plan
description: Verification matrix for protocol interoperability, offline security, browser behavior, and package artifacts.
owner: webllm
status: proposed
tags: [mcp, testing, security, browser]
---

## Scope

This plan covers `@renderify/mcp-app` and the shared IR/security/runtime changes
required for safe declarative events under a strict browser CSP.

## Test matrix

| Rule | Layer | Evidence |
| --- | --- | --- |
| Reject source, modules, components, network, storage, timers, profiles, and oversize plans | Unit | `tests/mcp-app.test.ts` plan corpus |
| Detach plans before returning or rendering | Unit | mutation-after-parse assertion |
| Emit valid official resource/tool metadata | Schema + SDK integration | official Zod schemas and in-memory `McpServer`/`Client` |
| Forward official request context with and without an input schema | SDK integration | handler argument, signal, request ID, and notification assertions |
| Roll back the resource when paired tool registration fails | SDK integration | duplicate-tool registration and resource-list assertion |
| Hash every inline script and escape configuration | Unit | CSP hash reconstruction and script-breakout fixture |
| Normalize provided browser bundle line endings and reject empty or null-containing bundles | Unit | normalized CSP hash, byte-count, and rejection assertions |
| Resolve relative browser view entries from the configured or current working directory | Unit | custom `viewEntry` bundle assertion |
| Reject SVG animation and timed attribute mutation after URL validation | Unit + renderer regression | SMIL plan corpus and sanitized-tag assertions |
| Reject fragment navigation and resource hrefs under an inherited HTTP `srcdoc` base URL | Unit + browser security | element-aware URL corpus and HTTP-origin view rejection |
| Reject CSS `image-set()` string URLs in URL attributes and inline styles | Security + renderer + MCP + browser | direct, prefixed, escaped, and commented fixtures plus HTTP-origin request observation |
| Reject runtime templates in URL-bearing attributes before interpolation | MCP unit + browser security | state-derived relative URL fixture under an HTTP-origin `srcdoc` host |
| Allow declarative events but reject malformed inline handlers | Security regression | `tests/security.test.ts` |
| Reject case-variant inline event attributes before HTML serialization | Security + renderer + browser | `OnClick` and `ONCLICK` rejection fixtures |
| Complete official handshake and teardown | Browser integration | official `AppBridge` in `tests/e2e/mcp-app.test.ts` |
| Join concurrent controller disposal and close the bridge once | Browser lifecycle | delayed fake-app close with two concurrent `dispose()` callers |
| Disconnect adapter-owned automatic resize observation on teardown | Browser lifecycle | instrumented `ResizeObserver` create/disconnect counts |
| Ignore a delayed tool result after teardown | Browser lifecycle | deferred official `tools/call` response in `tests/e2e/mcp-app.test.ts` |
| Keep the current view when an app-called tool returns `isError` | Browser lifecycle | official error result with a valid structured plan |
| Keep identical replacement markup mounted while refreshing its session metadata | Browser lifecycle | same-plan app-tool replacement assertion |
| Reuse and detach delegated DOM listeners across plan replacement, rejection, and teardown | Browser lifecycle | instrumented mount listener counts |
| Ignore valid JSON-RPC from a sibling frame | Browser security | spoofed tool-result notification |
| Enforce exact tool allowlist | Browser security | blocked and allowed button cases |
| Make no external requests and produce no page errors | Browser security | Playwright request/error capture |
| Publish both ESM/CJS root and view exports | Artifact | metadata validator and artifact smoke script |
| Include the repository MIT license in the published package | Artifact | npm pack manifest and exact license-content check |

## Negative cases

- Malformed structured content.
- Missing or unsupported spec version.
- Script-closing, empty, and null-containing browser bundles.
- Control-character-obfuscated `mailto:` and `tel:` navigation.
- Fragment-only hrefs on navigation and resource-loading elements.
- SVG animation or timed mutation of URL attributes.
- Host without server-tools capability.
- Tool event outside the allowlist.
- Message with the wrong `event.source`.

## Commands

```bash
pnpm validate
pnpm typecheck
pnpm lint
pnpm unit
pnpm compat
pnpm build
pnpm artifacts:smoke
pnpm e2e
```

## Exit criteria

Every command passes without skipped MCP tests. The browser test reports zero
HTTP(S) requests from the view and zero uncaught page errors.

## Verification

The commands and named test files above are the verification paths; CI does not
yet parse this document as a machine-enforced test catalog.
