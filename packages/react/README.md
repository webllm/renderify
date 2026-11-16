# @renderify/react

React components for UIs that a model describes. Render a validated
RuntimePlan with `<RenderifyView>`, or run model-written JSX in a sandboxed
iframe with `<RenderifyFrame>`.

## Install

```bash
npm install @renderify/react @renderify/ir
```

Works with React 18.2 and newer, including the Next.js App Router (the
components are client components).

## Render a plan

```tsx
import { RenderifyView } from "@renderify/react";

export function ToolResult({ plan }) {
  return (
    <RenderifyView
      plan={plan}
      onEvent={(event, state) => console.log(event.type, state)}
      renderError={(error) => <p>Could not show this UI: {error.message}</p>}
    />
  );
}
```

- The plan is checked against a security profile (`securityProfile`,
  `balanced` by default) before it renders; rejected plans call `onError` and
  `renderError`.
- Events run the plan's transitions locally. `onEvent` receives each event
  with the resulting state.
- The view remounts only when the plan's content changes, so passing an equal
  plan object on every render (common with chat messages) keeps its state.

`useRenderifySession(plan, options)` is the hook behind it. It returns a `ref`
for your own element, plus `status`, `error`, `state`, and the live `session`.

## Run model-written JSX

```tsx
import { RenderifyFrame } from "@renderify/react";

<RenderifyFrame
  source={code}
  allowedActions={["save"]}
  onAction={(action) => save(action.payload)}
  onError={(error) => console.error(error)}
/>;
```

The code runs in a [`@renderify/frame`](https://github.com/webllm/renderify/blob/main/docs/sandboxed-frame.md)
sandbox: an opaque-origin iframe that cannot read your page. Rendered code
calls `window.renderify.action(type, payload)`, and only allowlisted types
reach `onAction`. Frame options are read on mount; change the component's
`key` to apply new ones.

## Use with agent frameworks

See the [integrations guide](https://github.com/webllm/renderify/blob/main/docs/integrations.md)
for the Vercel AI SDK, CopilotKit, assistant-ui, and AG-UI, and the
[Next.js chat template](https://github.com/webllm/renderify/tree/main/templates/nextjs-chat).
