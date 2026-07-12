# @renderify/cli

## 0.8.0

### Minor Changes

- b849de6, 06de480: Add `renderify auth codex login|status|logout` with a private local credential store, automatic access-token refresh, direct token/base-URL overrides, and a bounded, cancellable device-code login flow. CLI-created LLM clients can now use the stored credentials for the `openai-codex` provider.
- a74e0af: Add explicit Playground host configuration through `--host` and `RENDERIFY_PLAYGROUND_HOST`.

### Patch Changes

- 38a96b8, 747ca06: Keep `plan.source` execution behind the server security/runtime pipeline. The browser now renders only server-produced HTML, source iframes cannot execute scripts, and explicitly mapped third-party Preact imports execute through the configured runtime.
- a74e0af, e372317: Bind Playground to `127.0.0.1` by default and reject cross-origin or malformed browser mutation requests while preserving non-browser API clients.
- a626c68, 7e66c7e, 7eb9b02: Preserve explicit module-manifest pins, hydrate missing integrity for auto-pinned modules, and harden integrity downloads with host checks on every redirect, redirect/size/time limits, and a bounded policy-scoped cache.
- f081c25: Make `probe-plan` exit unsuccessfully when its compatibility report is not `ok`, allowing it to act as a CI gate.
- da3fc0a, f9bc219: Recognize Codex endpoints in Playground tracing and reduce LLM/debug logs to bounded, redacted metadata so credentials, account IDs, prompts, and generated content are not emitted.
- 7d9e4ae, c12f809: Publish unambiguous `.mjs` and `.cjs` entry points and make package cleanup work cross-platform.
- Updated dependencies:
  - @renderify/core@0.8.0
  - @renderify/ir@0.8.0
  - @renderify/llm@0.8.0
  - @renderify/runtime@0.8.0
  - @renderify/security@0.8.0

## 0.7.0

### Minor Changes

- fix

### Patch Changes

- Updated dependencies [e86c0ad]
- Updated dependencies
- Updated dependencies [17a4f62]
  - @renderify/core@0.7.0
  - @renderify/llm@0.7.0
  - @renderify/runtime@0.7.0
  - @renderify/ir@0.7.0
  - @renderify/security@0.7.0

## 0.6.1

### Patch Changes

- Accept `securityProfile: "trusted"` in CLI config so preload validation supports plans that use the trusted browser source lane.

- Updated dependencies []:
  - @renderify/core@0.6.1
  - @renderify/ir@0.6.1
  - @renderify/llm@0.6.1
  - @renderify/runtime@0.6.1
  - @renderify/security@0.6.1

## 0.6.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.6.0
  - @renderify/ir@0.6.0
  - @renderify/llm@0.6.0
  - @renderify/runtime@0.6.0
  - @renderify/security@0.6.0

## 0.5.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.5.0
  - @renderify/ir@0.5.0
  - @renderify/llm@0.5.0
  - @renderify/runtime@0.5.0
  - @renderify/security@0.5.0

## 0.4.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.4.0
  - @renderify/ir@0.4.0
  - @renderify/llm@0.4.0
  - @renderify/runtime@0.4.0
  - @renderify/security@0.4.0

## 0.3.0

### Minor Changes

- fix render and update docs

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.3.0
  - @renderify/ir@0.3.0
  - @renderify/llm@0.3.0
  - @renderify/runtime@0.3.0
  - @renderify/security@0.3.0

## 0.2.0

### Minor Changes

- fix renderer

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.2.0
  - @renderify/ir@0.2.0
  - @renderify/llm@0.2.0
  - @renderify/runtime@0.2.0
  - @renderify/security@0.2.0

## 0.1.0

### Minor Changes

- implement core

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.1.0
  - @renderify/ir@0.1.0
  - @renderify/llm@0.1.0
  - @renderify/runtime@0.1.0
  - @renderify/security@0.1.0
