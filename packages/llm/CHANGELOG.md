# @renderify/llm

## 0.9.0

### Minor Changes

- af75248, 46c479f, 86c22fd: Add the public
  `OpenAICodexReasoningEffort` type and Codex reasoning payloads. Spark defaults
  to `low`, accepts `low`, `medium`, `high`, or `xhigh`, and rejects invalid or
  unsupported values before making a request.
- af75248, 533cda9: Strengthen the Codex RuntimePlan schema and instructions,
  normalize compatible structured responses, and generate collision-resistant
  fallback plan IDs.
- bb1a051: Preserve configured Ollama system and fallback instructions when a
  request supplies additional repair guidance.

### Patch Changes

- Updated dependencies:
  - @renderify/core@0.9.0
  - @renderify/ir@0.9.0

## 0.8.0

### Minor Changes

- 996edaa, 2dce214, 8326303, da3fc0a: Add and document `OpenAICodexLLMInterpreter` plus the `openai-codex` registry provider with text responses, SSE streaming, RuntimePlan JSON-schema output, `gpt-5.5` as the default model, and a 300-second default timeout.
- a262fe1: Add native Ollama structured-output requests with RuntimePlan validation, reliability controls, and timeout handling.

### Patch Changes

- 68c4639, 2dce214, 13827f5: Send Codex Responses input as message items, consume structured responses as a stream, and use a schema compatible with the Codex/OpenAI strict structured-output subset.
- 9ebd445: Treat Codex `response.failed`, `response.incomplete`, and top-level error events as failures instead of successful stream completion.
- df6978c: Bound error-response reads, preserve JSON/plain-text error details from one body consumption, and cancel failed bodies before retries without blocking the retry path.
- ac6e194: Cancel and release OpenAI, Codex, Anthropic, Google, and Ollama response streams when callers stop consuming early.
- 3539cca: Make LM Studio honor both provider-native and generic Renderify configuration keys while preserving its local defaults.
- 7d9e4ae, c12f809: Publish unambiguous `.mjs` and `.cjs` entry points and make package cleanup work cross-platform.
- Updated dependencies:
  - @renderify/core@0.8.0
  - @renderify/ir@0.8.0

## 0.7.0

### Minor Changes

- fix

### Patch Changes

- e86c0ad: Clean up package sources to satisfy Biome lint rules.
- Updated dependencies [e86c0ad]
- Updated dependencies
  - @renderify/core@0.7.0
  - @renderify/ir@0.7.0

## 0.6.1

### Patch Changes

- Update OpenAI, Anthropic, and Google provider guidance so `source.runtime="preact"` plans target the trusted browser source lane.

- Updated dependencies []:
  - @renderify/core@0.6.1
  - @renderify/ir@0.6.1

## 0.6.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.6.0
  - @renderify/ir@0.6.0

## 0.5.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.5.0
  - @renderify/ir@0.5.0

## 0.4.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.4.0
  - @renderify/ir@0.4.0

## 0.3.0

### Minor Changes

- fix render and update docs

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.3.0
  - @renderify/ir@0.3.0

## 0.2.0

### Minor Changes

- fix renderer

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.2.0
  - @renderify/ir@0.2.0

## 0.1.0

### Minor Changes

- implement core

### Patch Changes

- Updated dependencies []:
  - @renderify/core@0.1.0
  - @renderify/ir@0.1.0
