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

## Framework Adapter Components

Runtime exports preact bridge components for mounting framework-native components inside Renderify trees:

- `VueAdapter`
- `SvelteAdapter`
- `SolidAdapter`

```tsx
import { VueAdapter } from "@renderify/runtime";
import Counter from "vue-counter-component";

export default function App() {
  return <VueAdapter component={Counter} props={{ initial: 1 }} />;
}
```

These adapters lazy-load framework runtimes via ESM `import()` and expose fallback text on mount failures.

## Themes & Layout Primitives

Runtime also exports pre-built theme tokens and layout primitives:

- `renderifyThemes`, `resolveRenderifyTheme`, `ThemeProvider`
- `Stack`, `Inline`, `Grid`, `Surface`, `MetricTile`

```tsx
import { ThemeProvider, Grid, MetricTile } from "@renderify/runtime";

export default function Dashboard() {
  return (
    <ThemeProvider theme="aurora">
      <Grid columns={3}>
        <MetricTile label="Requests" value="12.3k" delta="+8.2%" tone="success" />
      </Grid>
    </ThemeProvider>
  );
}
```

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
