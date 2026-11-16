# @renderify/frame

Run untrusted UI code, such as JSX or TSX a model just wrote, in an
opaque-origin sandboxed iframe. The code renders and stays interactive, but it
cannot read your page, cookies, or storage, and it reaches your page only
through actions you allow.

## Install

```bash
npm install @renderify/frame
```

## Usage

```ts
import { createRenderifyFrame } from "@renderify/frame";

const frame = createRenderifyFrame({
  container: document.getElementById("preview")!,
  allowedActions: ["save"],
  onAction: (action) => console.log(action.type, action.payload),
});

await frame.render({
  source: `export default function App() {
    return <button onClick={() => window.renderify.action("save", { ok: true })}>Save</button>;
  }`,
});

await frame.render({ plan: runtimePlan }); // RuntimePlans work too
```

- `sandbox="allow-scripts"` only, with a strict CSP: scripts and requests are
  limited to the runner origin and the module CDNs (`moduleOrigins`).
- One private `MessagePort`; the runner accepts it only from its parent, once.
- Only allowlisted action types reach `onAction`.
- Synchronous loops stop after `loopTimeoutMs` (1.5 s); a render that exceeds
  `timeoutMs` (45 s) rejects and the iframe is replaced.
- The iframe sizes itself to its content (`autoResize`), and `setTheme`
  applies CSS custom properties inside it.

The runner script (`@renderify/frame/runner.js`) loads from jsDelivr, pinned
to this package version with Subresource Integrity. To self-host it, copy the
file to your static assets and pass `runnerUrl`.

## Not responsible for

- Stopping rendered content from misleading users inside its rectangle.
- Keeping secrets you pass into the frame from leaking through module CDN
  request URLs.
- MCP Apps; `@renderify/mcp-app` stays declarative and offline.

See the [sandboxed frame guide](https://github.com/webllm/renderify/blob/main/docs/sandboxed-frame.md)
and [ADR-0002](https://github.com/webllm/renderify/blob/main/docs/adr/0002-sandboxed-source-frame.md).
