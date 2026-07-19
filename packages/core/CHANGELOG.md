# @renderify/core

## 0.10.0

### Minor Changes

- 00c24d3, fa0ae3a, 3e7b64e, 6a29dd1, edefc60: Generate explicit trusted
  JSX, React, and Material UI requests as constrained source plans. Material UI
  imports are normalized onto one portable package graph, bounded source-plan
  budgets are applied, and controlled `TextField` prompts use React-compatible
  `onChange` handlers.
- ea8da82, bd9315e, 40e23c7, 1be185b: Harden structured plan generation and
  repair. Invalid text fallbacks now fail closed, a final structured recovery is
  attempted with actionable validation feedback, and prompts reflect the active
  source policy and declarative template grammar.

### Patch Changes

- 5c1490d: Bound the default `gpt-5.3-codex-spark` request timeout to 30 seconds
  unless the host explicitly configures another value.
- c9d35da: Re-export `DefaultUIRendererOptions` so hosts can inject the browser
  renderer used for interactive source plans through the core UI surface.
- Updated dependencies:
  - @renderify/ir@0.10.0
  - @renderify/runtime@0.10.0
  - @renderify/security@0.10.0

## 0.9.0

### Minor Changes

- af75248, 86c22fd: Add typed LLM reasoning-effort configuration, including
  `RENDERIFY_LLM_REASONING_EFFORT`, and fail fast when an unsupported value is
  supplied.
- af75248: Strengthen structured retries and text fallback with bounded previous
  output, validation errors, and explicit RuntimePlan repair instructions.
- 1b3595c, 55ceba9: Normalize compatible DOM-like model output while rejecting
  malformed source-backed plans before code generation treats them as valid.

### Patch Changes

- 6773bdd, aa89259: Refresh the Preact development dependencies used to validate
  the core package.
- Updated dependencies:
  - @renderify/ir@0.9.0
  - @renderify/runtime@0.9.0
  - @renderify/security@0.9.0

## 0.8.0

### Minor Changes

- 996edaa, 2dce214, 8326303: Recognize `openai-codex` in core configuration with the Codex Responses base URL, `gpt-5.5` default model, and a 300-second request timeout.
- 3539cca: Apply provider-specific default models and loopback base URLs when Ollama or LM Studio is selected without explicit overrides.

### Patch Changes

- 45757fe, 5e669a5, aef1d9c: Serialize concurrent application start/stop transitions, pass a normalized snapshot of application context into runtime execution and previews, and return/report the plan and security result actually used after `beforeRuntime` hooks.
- 03ac0c5, f8d7bd2, 782810b: Detach configuration, context-state, subscriber, and registered-API snapshots so caller mutation cannot alter internal state.
- 8e856ec: Bound and cancel API error-response body reads, including stalled bodies after request timeout.
- 140e616, 0a0b4c7, 9f79d3c: Make code generation select the first JSON payload that is actually a RuntimePlan/node, avoid heuristic source rewrites when syntax is already valid, and generate collision-resistant fallback plan IDs.
- 44d8c89, ac6e194: Emit one truthful full-text delta for non-streaming structured responses and close upstream LLM streams plus performance measurements when consumers stop early or abort.
- 42cfc5f: Keep the active security policy authoritative over runtime source execution instead of allowing runtime option overrides to silently enable it.
- 84bc3de: Restore the complete `@renderify/security` API re-export from the core entry point.
- 7d9e4ae, c12f809: Publish unambiguous `.mjs` and `.cjs` entry points and make package cleanup work cross-platform.
- Updated dependencies:
  - @renderify/ir@0.8.0
  - @renderify/runtime@0.8.0
  - @renderify/security@0.8.0

## 0.7.0

### Minor Changes

- fix

### Patch Changes

- e86c0ad: Clean up package sources to satisfy Biome lint rules.
- Updated dependencies [e86c0ad]
- Updated dependencies
- Updated dependencies [17a4f62]
  - @renderify/runtime@0.7.0
  - @renderify/ir@0.7.0
  - @renderify/security@0.7.0

## 0.6.1

### Patch Changes

- Add `"trusted"` to config-level security profile parsing so runtime configuration can opt into the trusted browser source lane.
- Update framework adapter instructions to render TSX/JSX adapter output with `renderTrustedPlanInBrowser` or the `"trusted"` security profile.

- Updated dependencies []:
  - @renderify/ir@0.6.1
  - @renderify/runtime@0.6.1
  - @renderify/security@0.6.1

## 0.6.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.6.0
  - @renderify/runtime@0.6.0
  - @renderify/security@0.6.0

## 0.5.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.5.0
  - @renderify/runtime@0.5.0
  - @renderify/security@0.5.0

## 0.4.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.4.0
  - @renderify/runtime@0.4.0
  - @renderify/security@0.4.0

## 0.3.0

### Minor Changes

- fix render and update docs

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.3.0
  - @renderify/runtime@0.3.0
  - @renderify/security@0.3.0

## 0.2.0

### Minor Changes

- fix renderer

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.2.0
  - @renderify/runtime@0.2.0
  - @renderify/security@0.2.0

## 0.1.0

### Minor Changes

- implement core

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.1.0
  - @renderify/runtime@0.1.0
  - @renderify/security@0.1.0
