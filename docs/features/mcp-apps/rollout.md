---
type: rollout
title: MCP Apps Rollout
description: Releases the adapter as an opt-in package with a text fallback and no migration requirement.
owner: webllm
status: proposed
tags: [mcp, release, rollback]
---

## Release stages

1. Publish `@renderify/mcp-app` as `0.1.0` from its pending Changeset, alongside
   patch releases of IR, security, and runtime.
2. Keep adoption opt-in; server authors explicitly register the UI resource.
3. Validate at least one official-bridge Chromium path before each release.
4. Widen host compatibility only through observed conformance evidence.

## Compatibility

The display tool includes text content for non-App clients. The package uses the
official helper's modern and legacy resource-URI metadata. Existing Renderify
browser/CLI APIs are unchanged.

## Rollback

Stop registering the UI resource and return the same text summary from the tool.
No persisted state or schema must be rolled back. If a shared patch regresses
declarative events, revert the shared parser change together across IR,
security, and runtime to avoid layer disagreement.

## Release blockers

- Any source/module/network path accepted by the MCP validator.
- Any unexpected view request, CSP violation, or uncaught browser error.
- Official bridge initialization or teardown failure.
- Package metadata or ESM/CJS artifact smoke failure.

## Verification

- `pnpm changeset:check`
- `pnpm test:all`
- `pnpm build && pnpm artifacts:smoke`
