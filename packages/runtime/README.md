# @renderify/runtime

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/runtime.svg)
![license](https://img.shields.io/npm/l/@renderify/runtime)

Runtime execution engine for Renderify.

`@renderify/runtime` executes RuntimePlan trees, resolves JSPM modules, supports runtime source modules (TSX/JSX/TS/JS), and renders output to HTML or browser targets.

## Install

```bash
pnpm add @renderify/runtime @renderify/ir @renderify/security
# or
npm i @renderify/runtime @renderify/ir @renderify/security
```

## Main Exports

- `DefaultRuntimeManager`
- `DefaultUIRenderer`
- `JspmModuleLoader`
- `renderPlanInBrowser`
- `BabelRuntimeSourceTranspiler`
- Types from `runtime-manager.types.ts` and `ui-renderer.ts`

## Quick Start (Browser)

```ts
import { renderPlanInBrowser } from "@renderify/runtime";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "demo",
  version: 1,
  capabilities: { domWrite: true },
  root: { type: "element", tag: "div", children: [{ type: "text", value: "Hello" }] },
};

await renderPlanInBrowser(plan, { target: "#app" });
```

## Quick Start (Manual Runtime)

```ts
import { DefaultRuntimeManager, JspmModuleLoader, DefaultUIRenderer } from "@renderify/runtime";

const runtime = new DefaultRuntimeManager({ moduleLoader: new JspmModuleLoader() });
const ui = new DefaultUIRenderer();

await runtime.initialize();
const execution = await runtime.execute({ plan });
const html = await ui.render(execution);
await runtime.terminate();
```

## Notes

- `renderPlanInBrowser` includes security checks by default (`DefaultSecurityChecker`).
- Runtime source modules can run with browser sandbox modes (`worker` / `iframe`) via runtime options.
