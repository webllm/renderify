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
| Hash every inline script and escape configuration | Unit | CSP hash reconstruction and script-breakout fixture |
| Allow declarative events but reject malformed inline handlers | Security regression | `tests/security.test.ts` |
| Complete official handshake and teardown | Browser integration | official `AppBridge` in `tests/e2e/mcp-app.test.ts` |
| Ignore a delayed tool result after teardown | Browser lifecycle | deferred official `tools/call` response in `tests/e2e/mcp-app.test.ts` |
| Keep the current view when an app-called tool returns `isError` | Browser lifecycle | official error result with a valid structured plan |
| Reuse and detach delegated DOM listeners across plan replacement, rejection, and teardown | Browser lifecycle | instrumented mount listener counts |
| Ignore valid JSON-RPC from a sibling frame | Browser security | spoofed tool-result notification |
| Enforce exact tool allowlist | Browser security | blocked and allowed button cases |
| Make no external requests and produce no page errors | Browser security | Playwright request/error capture |
| Publish both ESM/CJS root and view exports | Artifact | metadata validator and artifact smoke script |

## Negative cases

- Malformed structured content.
- Missing or unsupported spec version.
- Script-closing configuration and browser bundles.
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
