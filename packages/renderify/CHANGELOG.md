# renderify

## 0.9.0

### Minor Changes

- af75248, 46c479f, 86c22fd: Expose Codex Spark reasoning controls through the
  SDK facade, including the public `OpenAICodexReasoningEffort` type and
  fail-fast validation for invalid effort configuration.
- af75248, 924f4fa, 2be9f5e: Ship the hardened RuntimePlan normalization,
  structured repair, and React-style object rendering pipeline through the main
  `renderify` package.

### Patch Changes

- Updated dependencies:
  - @renderify/core@0.9.0
  - @renderify/ir@0.9.0
  - @renderify/llm@0.9.0
  - @renderify/runtime@0.9.0
  - @renderify/security@0.9.0

## 0.8.0

### Minor Changes

- 996edaa, da3fc0a: Re-export `OpenAICodexLLMInterpreter`, `OpenAICodexLLMInterpreterOptions`, and `openaiCodexLLMProvider` so the top-level SDK can configure and create the new `openai-codex` provider directly, and document the CLI authentication flow used to select it.

### Patch Changes

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

- Re-export `renderTrustedPlanInBrowser` and `createTrustedInteractiveSession` from the top-level SDK facade.

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
