# Browser Integration

Renderify is designed for browser-first execution. This guide covers how to embed Renderify in web applications, from simple one-line embeds to full streaming chat interfaces.

Use `renderPlanInBrowser` for declarative plans and `source.runtime: "renderify"` modules. Use `renderTrustedPlanInBrowser` for reviewed browser source modules that run with `source.runtime: "preact"`.

## One-Line Embed API

The simplest way to render a plan in the browser:

```ts
import { renderPlanInBrowser } from "@renderify/runtime";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
  /* ... */
};

const result = await renderPlanInBrowser(plan, {
  target: "#app", // CSS selector, HTMLElement, or InteractiveRenderTarget
});

console.log(result.html);
console.log(result.execution.diagnostics);
```

### Options

```ts
interface RuntimeEmbedRenderOptions {
  target?: string | HTMLElement | InteractiveRenderTarget;
  context?: RuntimeExecutionContext;
  signal?: AbortSignal;
  runtime?: RuntimeManager;
  runtimeOptions?: RuntimeManagerOptions;
  security?: SecurityChecker;
  securityInitialization?: SecurityInitializationInput;
  ui?: UIRenderer;
  autoInitializeRuntime?: boolean;
  autoTerminateRuntime?: boolean;
  serializeTargetRenders?: boolean;
}
```

The same options shape is used by both `renderPlanInBrowser` and `renderTrustedPlanInBrowser`.

- **`target`** — where to mount the rendered UI. Accepts a CSS selector string, an HTMLElement reference, or an `InteractiveRenderTarget` for event-capable rendering.
- **`context`** — execution context with `userId` and `variables`.
- **`signal`** — optional `AbortSignal` for cancellation.
- **`runtime` / `runtimeOptions`** — provide a custom runtime instance, or configure a default one.
- **`security` / `securityInitialization`** — custom checker and initialization profile/overrides.
- **`ui`** — custom UI renderer (defaults to `DefaultUIRenderer`).
- **`autoInitializeRuntime` / `autoTerminateRuntime`** — control runtime lifecycle when using embed API.
- **`serializeTargetRenders`** — serialize concurrent renders per mount target (enabled by default).

### Return Value

```ts
interface RuntimeEmbedRenderResult {
  html: string;
  execution: RuntimeExecutionResult;
  security: SecurityCheckResult;
  runtime: RuntimeManager;
}
```

## Interactive Rendering

For dynamic UI with event handling and DOM reconciliation, use an `InteractiveRenderTarget`:

```ts
const container = document.getElementById("app")!;

const result = await renderPlanInBrowser(plan, {
  target: {
    element: container,
  },
});
```

When using an `InteractiveRenderTarget`:

- The UI renderer mounts to the DOM element instead of just generating HTML strings
- Event bindings are delegated at the mount point
- Subsequent renders use DOM reconciliation (diffing) for efficient updates
- Input element focus and values are preserved across renders

### Event Handling

Runtime events are dispatched as custom DOM events:

```ts
container.addEventListener("renderify:runtime-event", (event) => {
  const { planId, event: runtimeEvent } = event.detail;
  console.log("Event:", planId, runtimeEvent.type, runtimeEvent.payload);
});
```

For built-in event->state->rerender orchestration, use `createInteractiveSession`:

```ts
import { createInteractiveSession } from "@renderify/runtime";

const session = await createInteractiveSession(plan, {
  target: "#app",
});

await session.dispatch({
  type: "increment",
  payload: { delta: 1 },
});
```

If the plan uses `source.runtime: "preact"`, use `createTrustedInteractiveSession` instead. It applies the same trusted-source defaults as `renderTrustedPlanInBrowser`.

## Concurrent Render Safety

Multiple renders to the same DOM target are automatically serialized:

```ts
// These run sequentially, not concurrently
const [result1, result2] = await Promise.all([
  renderPlanInBrowser(planA, { target: "#app" }),
  renderPlanInBrowser(planB, { target: "#app" }),
]);
```

This uses a WeakMap-based lock mechanism to prevent DOM corruption from overlapping renders.

## HTML-Only Integration

For environments without a build system, load Renderify runtime through native ESM:

```html
<!DOCTYPE html>
<html>
  <body>
    <div id="app"></div>
    <script type="module">
      import { renderPlanInBrowser } from "https://esm.sh/@renderify/runtime";

      const plan = {
        specVersion: "runtime-plan/v1",
        id: "hello",
        version: 1,
        root: {
          type: "element",
          tag: "div",
          children: [{ type: "text", value: "Hello from Renderify" }],
        },
        capabilities: {},
      };

      await renderPlanInBrowser(plan, { target: "#app" });
    </script>
  </body>
</html>
```

Note: `@renderify/runtime` currently publishes ESM/CJS entries (no UMD bundle). `@renderify/ir` and `@renderify/security` still publish UMD files (`dist/ir.umd.min.js`, `dist/security.umd.min.js`).

## Trusted TSX Source Rendering (Babel + JSPM)

For `source.runtime: "preact"` plans, Babel standalone is needed for transpilation and the trusted embed helper should be used:

```html
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="module">
  import { renderTrustedPlanInBrowser } from "https://esm.sh/@renderify/runtime";

  const plan = {
    specVersion: "runtime-plan/v1",
    id: "tsx-demo",
    version: 1,
    root: { type: "text", value: "" },
    capabilities: { domWrite: true },
    source: {
      code: `
        import { useState } from "preact/hooks";
        export default function Counter() {
          const [count, setCount] = useState(0);
          return (
            <button onClick={() => setCount(c => c + 1)}>
              Count: {count}
            </button>
          );
        }
      `,
      language: "tsx",
      runtime: "preact",
    },
    moduleManifest: {
      preact: {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
      },
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
      },
      "preact/jsx-runtime": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
      },
    },
  };

  await renderTrustedPlanInBrowser(plan, { target: "#app" });
</script>
```

`runtime: "preact"` is a trusted browser source lane. Use it for reviewed source modules that need JSX, hooks, or third-party UI packages. For untrusted source modules, stay on the declarative path or `source.runtime: "renderify"` with sandboxing.

## Hash-Based Code Runner

Renderify supports URL hash payloads for sharing executable UI:

```html
<!-- Load plan from URL hash -->
<script type="module">
  import {
    renderPlanInBrowser,
    renderTrustedPlanInBrowser,
  } from "https://esm.sh/@renderify/runtime";

  const hash = new URLSearchParams(location.hash.slice(1));

  if (hash.has("plan64")) {
    const json = atob(hash.get("plan64").replace(/-/g, "+").replace(/_/g, "/"));
    const plan = JSON.parse(json);
    await renderPlanInBrowser(plan, { target: "#app" });
  }

  if (hash.has("jsx64") || hash.has("tsx64")) {
    const key = hash.has("jsx64") ? "jsx64" : "tsx64";
    const code = atob(hash.get(key).replace(/-/g, "+").replace(/_/g, "/"));
    const runtime = hash.get("runtime") || "preact";

    const plan = {
      specVersion: "runtime-plan/v1",
      id: "hash-source",
      version: 1,
      root: { type: "text", value: "" },
      capabilities: { domWrite: true },
      source: { code, language: key.replace("64", ""), runtime },
    };

    const renderSource =
      runtime === "preact"
        ? renderTrustedPlanInBrowser
        : renderPlanInBrowser;

    await renderSource(plan, { target: "#app" });
  }
</script>
```

Treat `jsx64` / `tsx64` payloads as trusted demo inputs when they target `runtime: "preact"`.

## DOM Reconciliation

The UI renderer implements efficient DOM reconciliation for interactive re-renders:

### How It Works

1. **Keyed matching** — elements with `data-renderify-key` or `key` attributes are matched by identity
2. **Positional matching** — elements at the same position in the same parent are reused
3. **Attribute diffing** — only changed attributes are updated
4. **Text content diffing** — text nodes are updated in-place
5. **Focus preservation** — active input elements retain their focus and value

### Using Keys

```json
{
  "type": "element",
  "tag": "li",
  "props": { "key": "item-1" },
  "children": [{ "type": "text", "value": "Item 1" }]
}
```

Keys enable correct reconciliation when list items are reordered, added, or removed.

## Security in the Browser

When embedding Renderify in a browser application:

1. **Match the helper to the trust lane** — `renderPlanInBrowser` defaults to the balanced profile; `renderTrustedPlanInBrowser` defaults to the trusted profile for `source.runtime: "preact"`
2. **Validate plans from external sources** — plans from URLs, APIs, or user input should always go through security checks
3. **Use sandbox mode only for non-Preact source** — worker, iframe, and ShadowRealm sandboxing apply to untrusted declarative plans or `source.runtime: "renderify"` modules; `source.runtime: "preact"` does not support those browser sandboxes
4. **Set appropriate security profile** — use `strict` for user-facing production deployments

```ts
import { DefaultSecurityChecker } from "@renderify/security";

const checker = new DefaultSecurityChecker();
checker.initialize({ profile: "strict" });

await renderPlanInBrowser(plan, {
  target: "#app",
  security: checker,
});
```

If you initialize a checker yourself, the embed helpers preserve that profile unless you also pass `securityInitialization`.

## Trusted Preact Source Rendering

When a plan's source module exports a Preact component, the trusted source rendering path uses Preact's native reconciliation instead of Renderify's declarative HTML serializer:

```
Source module
  → Transpile + import rewrite
    → Dynamic import
      → Extract default export (Preact component)
        → Create Preact VNode
          → Preact.render() to DOM element
```

This provides full React-compatible component rendering with hooks, state, effects, and refs. Treat that lane as reviewed source execution, not as the declarative RuntimeNode sanitizer path.

## Examples

The repository includes several browser examples:

| Example        | Path                                             | Description                                    |
| -------------- | ------------------------------------------------ | ---------------------------------------------- |
| Runtime plan   | `examples/runtime/browser-runtime-example.html`  | Browser plan rendering with local dist bundles |
| TSX + JSPM     | `examples/runtime/browser-tsx-jspm-example.html` | Babel transpilation with JSPM modules          |
| Chat dashboard | `examples/killer/one-line-chat-dashboard.html`   | Trusted TSX source dashboard demo              |
| Chat form      | `examples/killer/one-line-chat-form.html`        | Trusted TSX form demo with date-fns            |
| Sandbox worker | `examples/killer/one-line-sandbox-worker.html`   | Worker-sandboxed source execution              |
| Hash runner    | `examples/killer/hash-code-runner.html`          | Execute plans from URL hashes                  |
| Todo app       | `examples/todo/react-shadcn-todo.html`           | Trusted JSX todo app with local module manifest |
| Todo hash app  | `examples/todo/react-shadcn-todo-hash.html`      | Trusted JSX todo app with URL hash sync        |
