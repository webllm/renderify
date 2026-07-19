---
title: Renderer-only website Playground
description: Paste JSX, TSX, or RuntimePlan JSON and render it locally in an isolated browser document without an LLM request.
---

# Renderer-only website Playground

The [website Playground](/playground) is a static renderer host. It accepts code
that you paste or edit and sends it directly to a Renderify runtime running in
your browser. It has no prompt endpoint, provider configuration, API key input,
or LLM request.

This is intentionally different from the development CLI Playground:

| Surface | Input | LLM request | Host process |
| --- | --- | --- | --- |
| Website Playground | JSX/TSX or RuntimePlan JSON | Never | Static files in the browser |
| CLI Playground | Prompt, plan, or source | Optional, depending on action | Local Node.js server |

## JSX and TSX mode

Paste a module with a default component export:

```jsx
import { useState } from "preact/hooks";

export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```

The editor also supports React-compatible source and browser ESM packages such
as `@mui/material`. Renderify detects a React dependency graph, transpiles the
module, pins bare imports, and mounts it with the matching browser renderer.

Source modules use Renderify's **trusted** execution lane. Only run code you
have reviewed. The outer iframe is an extra host boundary; it does not turn
arbitrary JavaScript into a declarative or untrusted plan.

## RuntimePlan JSON mode

Use this mode for the declarative path. State text uses canonical
`{{state.path}}` templates and events dispatch named transitions:

```json
{
  "specVersion": "runtime-plan/v1",
  "id": "counter",
  "version": 1,
  "root": {
    "type": "element",
    "tag": "button",
    "props": { "onClick": "increment" },
    "children": [{ "type": "text", "value": "Count: {{state.count}}" }]
  },
  "capabilities": { "domWrite": true, "allowedModules": [] },
  "state": {
    "initial": { "count": 0 },
    "transitions": {
      "increment": [{ "type": "increment", "path": "count", "by": 1 }]
    }
  }
}
```

Invalid semantic fields, malformed templates, unsupported nodes, and rejected
capabilities fail the render instead of being silently accepted.

## Isolation and network behavior

Each preview starts in an iframe with `sandbox="allow-scripts"` and without
`allow-same-origin`. The editor communicates through a transferred
`MessagePort`; rendered code does not receive a reference to the parent page.
The iframe applies a restrictive Content Security Policy, and the trusted
runtime policy limits module traffic to the configured JSPM and esm.sh hosts.

The first render of a dependency-heavy example can be noticeably slower because
the browser must download the compiler and a cold browser module graph. Re-runs
reuse the iframe's transpilation and module caches. RuntimePlan-only examples do
not need the React or Material UI graph and start much faster.

Current website limits are:

- editor content up to 120,000 UTF-8 bytes;
- runtime execution budget up to 30 seconds;
- host timeout of 45 seconds, after which you can reset the sandbox;
- bare package imports resolved from browser ESM CDNs, so the first such render
  requires network access;
- no relative multi-file project graph or Node.js built-in modules.

## Share and reset

**Share** stores the current mode and UTF-8 source in the URL hash. The payload
stays in the URL and is not uploaded to a Renderify service. Long source creates
a long URL, so use a repository or gist for larger examples.

**Reset code** restores the default sample. **Reset sandbox** destroys the
current iframe and terminates its runtime state, which is also the recovery path
for a stuck document.

## Run locally

```bash
pnpm install
pnpm website:dev
```

Open `http://localhost:3000/playground`. The website build is also fully static:

```bash
pnpm website:build
pnpm website:preview
```
