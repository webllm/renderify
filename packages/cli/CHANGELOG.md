# @renderify/cli

## 0.10.0

### Minor Changes

- 170ab81: Reuse the local OpenAI Codex CLI login for the `openai-codex` provider. Set
  `RENDERIFY_CODEX_USE_CLI_AUTH=1` to import credentials from the official Codex
  CLI `auth.json` (`$CODEX_HOME`/`~/.codex`, overridable via
  `RENDERIFY_CODEX_CLI_AUTH_FILE`) so a locally hosted playground can run
  `gpt-5.3-codex-spark` without a separate `renderify auth codex login`. Use
  `only` to consult the Codex CLI file exclusively. Expiring access tokens are
  refreshed and written back to the Codex CLI file in its native format,
  preserving unknown keys, and `renderify auth codex status` now reports the
  active credential source. Disabled by default, so existing behavior is
  unchanged.
- c9d35da: Mount eligible JSX and TSX source plans as live browser applications
  in the playground. The server now prepares one matching React or Preact module
  graph, transpiles with the corresponding automatic JSX runtime, and mounts
  React and Material UI output with working styles, hooks, and event handlers.

### Patch Changes

- ec94d0c: Keep playground output faithful to the server result by removing the
  prompt-specific built-in Todo fallback that could replace a rejected or
  incomplete plan with unrelated client-side UI.
- 65cdd4d: Honor standard proxy environment variables for the CLI's outbound requests.
  Node's built-in `fetch` (undici) ignores `HTTP(S)_PROXY` / `ALL_PROXY` /
  `NO_PROXY`, so in a proxied network every request — LLM providers, Codex auth
  refresh, and remote module fetches — failed with a connect timeout even though
  `curl` and the official Codex CLI worked. When a proxy is configured, the CLI
  now installs undici's `EnvHttpProxyAgent` as the global dispatcher so those
  requests are routed through it. No effect when no proxy is set.
- Updated dependencies:
  - @renderify/core@0.10.0
  - @renderify/ir@0.10.0
  - @renderify/llm@0.10.0
  - @renderify/runtime@0.10.0
  - @renderify/security@0.10.0

## 0.9.0

### Minor Changes

- af75248, 86c22fd: Forward `RENDERIFY_LLM_REASONING_EFFORT` into CLI-created
  LLM clients, document the levels supported by Codex Spark, and reject invalid
  values during configuration instead of silently changing the requested effort.

### Patch Changes

- Updated dependencies:
  - @renderify/core@0.9.0
  - @renderify/ir@0.9.0
  - @renderify/llm@0.9.0
  - @renderify/runtime@0.9.0
  - @renderify/security@0.9.0

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
