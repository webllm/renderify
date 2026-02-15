# @renderify/core

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/core.svg)
![license](https://img.shields.io/npm/l/@renderify/core)

Core orchestration layer for Renderify.

`@renderify/core` wires together config, context, LLM, code generation, runtime execution, security checks, and UI rendering via `RenderifyApp`.

## Install

```bash
pnpm add @renderify/core @renderify/runtime @renderify/security @renderify/llm
# or
npm i @renderify/core @renderify/runtime @renderify/security @renderify/llm
```

## Main API

- `createRenderifyApp(deps)`
- `RenderifyApp`
- `PolicyRejectionError`
- `renderPrompt()` / `renderPromptStream()` / `renderPlan()`

The package also re-exports core interfaces from `api-integration`, `codegen`, `config`, `context`, `customization`, `llm-interpreter`, `performance`, `security`, and `ui`.

## Quick Start

```ts
import {
  createRenderifyApp,
  DefaultApiIntegration,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultUIRenderer,
} from "@renderify/core";
import { createLLMInterpreter } from "@renderify/llm";
import { DefaultRuntimeManager, JspmModuleLoader } from "@renderify/runtime";
import { DefaultSecurityChecker } from "@renderify/security";

const app = createRenderifyApp({
  config: new DefaultRenderifyConfig(),
  context: new DefaultContextManager(),
  llm: createLLMInterpreter({ provider: "openai" }),
  codegen: new DefaultCodeGenerator(),
  runtime: new DefaultRuntimeManager({ moduleLoader: new JspmModuleLoader() }),
  security: new DefaultSecurityChecker(),
  performance: new DefaultPerformanceOptimizer(),
  ui: new DefaultUIRenderer(),
  apiIntegration: new DefaultApiIntegration(),
  customization: new DefaultCustomizationEngine(),
});

await app.start();
const result = await app.renderPrompt("build a small dashboard");
console.log(result.html);
await app.stop();
```

## Streaming

Use `renderPromptStream()` for progressive updates from LLM output to UI preview chunks.

## Framework Adapter Plugins

`@renderify/core` now exports framework adapter plugins for Vue/Svelte/Solid:

- `createVueAdapterPlugin()`
- `createSvelteAdapterPlugin()`
- `createSolidAdapterPlugin()`

They do three things in the pipeline:

1. Enrich `beforeLLM` prompt instructions with framework-specific adapter hints.
2. Normalize framework code fences (`vue`, `svelte`, `solid-js`) to `tsx` in `beforeCodeGen`.
3. Annotate plan metadata and force JSX source runtime to `preact` in `afterCodeGen`.

```ts
import {
  DefaultCustomizationEngine,
  createVueAdapterPlugin,
} from "@renderify/core";

const customization = new DefaultCustomizationEngine();
customization.registerPlugin(createVueAdapterPlugin());
```

## Docs

- `../../docs/architecture.md`
- `../../docs/runtime-execution.md`
- `../../docs/browser-integration.md`
