---
title: Sandboxed frame
description: Run model-written JSX, TSX, and RuntimePlans in an opaque-origin iframe with @renderify/frame.
---

# Sandboxed frame

`@renderify/frame` runs untrusted UI code, such as JSX a model just wrote, in an
`<iframe sandbox="allow-scripts">` with an opaque origin. The code renders and
stays interactive, but it cannot read your page, cookies, or storage, and it
talks to your page only through actions you allow.

Use it when declarative RuntimePlans are not enough: npm libraries, custom
components, or anything you would otherwise have to run with the `trusted`
profile. The website [Playground](./website-playground.md) uses the same frame.

## Quick start

```bash
npm install @renderify/frame
```

```ts
import { createRenderifyFrame } from "@renderify/frame";

const frame = createRenderifyFrame({
  container: document.getElementById("preview")!,
  allowedActions: ["save"],
  onAction(action) {
    if (action.type === "save") {
      saveDraft(action.payload);
    }
  },
});

const result = await frame.render({
  language: "jsx",
  source: `
    import { useState } from "preact/hooks";
    export default function App() {
      const [count, setCount] = useState(0);
      return (
        <button onClick={() => {
          setCount(count + 1);
          window.renderify.action("save", { count: count + 1 });
        }}>
          Clicked {count} times
        </button>
      );
    }
  `,
});
console.log(result.framework, result.durationMs, result.diagnostics);
```

`render` also accepts a RuntimePlan: `frame.render({ plan })`. Declarative
events such as `onClick: "save"` become actions too.

## What the frame guarantees

| Property | How |
| --- | --- |
| No access to the host page | `sandbox="allow-scripts"` without `allow-same-origin` gives the content an opaque origin. |
| Limited network | The frame's CSP allows scripts and requests only to the runner's origin and the module CDNs (`ga.jspm.io`, `cdn.jspm.io`, `esm.sh` by default). Frames, workers, form submission, and `<base>` are blocked. |
| Private channel | The host connects with a transferred `MessagePort`. The runner accepts a connection only from its parent window, and only once. |
| Explicit host actions | Content calls `window.renderify.action(type, payload)`. Only types in `allowedActions` reach `onAction`; others go to `onBlockedAction`. Payloads are JSON, at most 64 KiB. |
| Recovers from hangs | Synchronous loops get a time check (`loopTimeoutMs`, 1.5 s by default) that throws instead of freezing the page. A render that exceeds `timeoutMs` (45 s) rejects with code `timeout` and the iframe is replaced. |
| Tamper-evident runner | The default runner URL is pinned to the package version and loaded with Subresource Integrity. |

The frame cannot stop content from misleading users inside its own rectangle,
and code can leak data you give it through module CDN request URLs. Do not
pass secrets into a frame. See [ADR-0002](./adr/0002-sandboxed-source-frame.md)
and the [threat model](./threat-model.md).

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `container` | required | Element the iframe is appended to. |
| `runnerUrl` | jsDelivr, this version | Where to load the runner script. |
| `runnerIntegrity` | built in for the default URL | SRI hash for a custom `runnerUrl`. |
| `runnerSource` | none | The runner's code, inlined into the frame instead of loaded from `runnerUrl`, for pages that must not fetch scripts. An inherited CSP must allow that script by hash. |
| `moduleOrigins` | JSPM and esm.sh | Origins rendered code may import from. Pass `[]` for offline plans. |
| `timeoutMs` | `45000` | Watchdog per render; the frame resets afterwards. |
| `bootTimeoutMs` | `20000` | How long the runner may take to connect. |
| `loopTimeoutMs` | `1500` | Limit for one synchronous loop; `0` disables the guard. |
| `maxInputBytes` | `262144` | Largest source or JSON plan accepted. |
| `autoResize` | `true` | Size the iframe to its content; pass `{ minHeight, maxHeight }` to clamp, or `false` to size it with CSS. |
| `theme` | none | `{ variables: { "--accent": "#4f46e5" }, colorScheme: "dark" }`; update with `setTheme`. |
| `allowedActions`, `onAction`, `onBlockedAction` | none | Action allowlist and handlers. |
| `onRuntimeError` | none | Errors thrown by content after it rendered, for example in a click handler. |
| `onStatusChange` | none | `booting`, `ready`, `rendering`, `rendered`, `failed`, `timed-out`, `disposed`. |

`render` rejects with a `RenderifyFrameError` whose `code` is `timeout`,
`superseded` (a newer render started), `reset`, `disposed`, `boot-failed`,
`render-failed`, or `invalid-input`. Errors inside rendered components are
reported as `error` diagnostics on a successful result, the same way the
runtime reports them elsewhere.

`renderSandboxedSource(container, source, options)` is a shortcut that creates
a frame and renders one module.

## Self-hosting the runner

The runner (`@renderify/frame/runner.js`, about 2.6 MB with Babel and the
runtime) is the only script that runs inside the frame. To avoid loading it
from jsDelivr, copy it to your static assets and pass its URL:

```ts
createRenderifyFrame({
  container,
  runnerUrl: "/assets/renderify-frame-runner.js",
  runnerIntegrity: "sha384-...", // optional; requires CORS on that response
});
```

Because the frame's origin is opaque, a script loaded with `runnerIntegrity`
is a cross-origin request: serve it with `Access-Control-Allow-Origin: *`.

## Choosing a lane

| Need | Use |
| --- | --- |
| Forms, lists, conditions, MCP Apps | Declarative RuntimePlans (no code runs) |
| Model-written JSX in an MCP App | `@renderify/mcp-app` with `sourceMode: true`, which nests this frame in the view |
| npm libraries, custom components from a model | `@renderify/frame` |
| Your own reviewed components | The `trusted` profile in your page |
