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

## Renderer-only (BYO LLM/Backend)

You do not need to use the built-in LLM providers. A common integration is to generate RuntimePlan externally and only use `renderify` for execution/rendering:

```ts
import { renderPlanInBrowser, renderPlanOnce } from "renderify";

const plan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only",
  version: 1,
  root: {
    type: "element",
    tag: "section",
    children: [{ type: "text", value: "Hello from external plan" }],
  },
  capabilities: { domWrite: true },
};

// Browser mount
await renderPlanInBrowser(plan, { target: "#app" });

// Optional one-shot execution in app orchestration flow
const result = await renderPlanOnce(plan);
console.log(result.html);
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
