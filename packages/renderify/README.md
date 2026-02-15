# renderify

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/renderify.svg)
![license](https://img.shields.io/npm/l/renderify)

Official Renderify SDK entry package.

`renderify` is the recommended top-level package for application developers. It provides:

- A batteries-included app factory (`createRenderify` / `startRenderify`)
- One-shot helpers (`renderPromptOnce`, `renderPlanOnce`)
- Re-exports from `@renderify/core`
- Provider/runtime helpers from `@renderify/llm` and `@renderify/runtime`

## Install

```bash
pnpm add renderify
# or
npm i renderify
```

## Quick Start

```ts
import { startRenderify } from "renderify";

const { app } = await startRenderify({
  llmProvider: "openai",
  llmProviderOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
  },
});

const result = await app.renderPrompt("build a KPI dashboard");
console.log(result.html);

await app.stop();
```

## One-shot Prompt Rendering

```ts
import { renderPromptOnce } from "renderify";

const result = await renderPromptOnce("build a todo list", {
  llmProvider: "openai",
  llmProviderOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
  },
});

console.log(result.plan);
console.log(result.html);
```

## Main Exports

- `createRenderify(options)`
- `startRenderify(options)`
- `renderPromptOnce(prompt, options)`
- `renderPlanOnce(plan, options)`
- `renderPlanInBrowser(plan, options)`
- LLM registry/provider exports (`createLLMInterpreter`, `LLMProviderRegistry`, ...)
- Full `@renderify/core` API surface

## Notes

- Node.js `>=22` is required.
- For advanced split-package usage, you can still import `@renderify/core`, `@renderify/runtime`, `@renderify/security`, `@renderify/llm`, and `@renderify/ir` directly.
