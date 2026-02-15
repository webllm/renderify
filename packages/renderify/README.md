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

### Renderer-only TSX + Dependency Package (JSPM)

`renderPlanInBrowser` defaults to `auto-pin-latest`, so bare imports work out of the box:

```ts
import { renderPlanInBrowser } from "renderify";

const tsxPlan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only_tsx_datefns",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "div",
    children: [{ type: "text", value: "Loading..." }],
  },
  source: {
    language: "tsx",
    runtime: "renderify",
    code: `
      import { format } from "date-fns/format";

      export default function App() {
        return <section>Today: {format(new Date(), "yyyy-MM-dd")}</section>;
      }
    `,
  },
};

await renderPlanInBrowser(tsxPlan, { target: "#app" });
```

For production determinism, prefer `manifest-only` (explicit pinned versions) and disable auto-pin:

```ts
const pinnedPlan = {
  ...tsxPlan,
  moduleManifest: {
    "date-fns/format": {
      resolvedUrl: "https://ga.jspm.io/npm:date-fns@4.1.0/format.js",
      version: "4.1.0",
    },
  },
};

await renderPlanInBrowser(pinnedPlan, {
  target: "#app",
  autoPinLatestModuleManifest: false,
});
```

Auto-pin-latest workflow (`renderPlanInBrowser` default):

1. Write bare imports for DX, for example `import { format } from "date-fns/format"`.
2. On first run, Renderify resolves the bare specifier via JSPM latest metadata.
3. Renderify immediately pins and injects the exact resolved URL/version into `moduleManifest`, then executes with pinned resolution.

Use `manifest-only` in production (`autoPinLatestModuleManifest: false`) when you want fully pre-pinned, reviewable dependency mappings.

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

- Default browser embedding behavior is `auto-pin-latest` for bare source imports; use `manifest-only` for production-grade deterministic deployments.
- Node.js `>=22` is required.
- For advanced split-package usage, you can still import `@renderify/core`, `@renderify/runtime`, `@renderify/security`, `@renderify/llm`, and `@renderify/ir` directly.
