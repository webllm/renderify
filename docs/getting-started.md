---
title: Getting started
description: Install Renderify, render your first RuntimePlan in React or plain JavaScript, and connect it to your model.
---

# Getting Started

Renderify renders UI that a model describes. A model (or your code) produces a
RuntimePlan, a JSON description of interactive UI with state, lists, forms,
and events; Renderify validates it, checks it against a security policy, and
renders it. When a plan is not enough and the model writes JSX, Renderify runs
that code in a sandboxed iframe instead of your page.

## Install

```bash
# React apps
npm install @renderify/react @renderify/ir

# Any framework or plain JavaScript
npm install @renderify/runtime @renderify/ir
```

Server-side packages require Node.js 22 or newer.

## Render a plan in React

```tsx
import { RenderifyView } from "@renderify/react";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "counter",
  version: 1,
  capabilities: { domWrite: true },
  state: {
    initial: { count: 0 },
    transitions: { increment: [{ type: "increment", path: "count" }] },
  },
  root: {
    type: "element",
    tag: "button",
    props: { onClick: "increment" },
    children: [{ type: "text", value: "Clicked {{state.count}} times" }],
  },
};

export function Counter() {
  return <RenderifyView plan={plan} onEvent={(event, state) => console.log(event.type, state)} />;
}
```

`<RenderifyView>` checks the plan against the `balanced` security profile,
renders it, and runs its transitions locally. Plans can also loop over arrays,
render conditionally, and bind form fields to state; see the
[RuntimePlan IR reference](./runtime-plan-ir.md).

## Render without React

```ts
import { createInteractiveSession } from "@renderify/runtime";

const session = await createInteractiveSession(plan, {
  target: document.getElementById("app")!,
});
console.log(session.getState());
```

For a one-off static render, use `renderPlanInBrowser(plan, { target: "#app" })`.

## Let your model produce plans

Give your model a `render_ui` tool whose input is a RuntimePlan, and render the
tool result with `<RenderifyView>`. `@renderify/ir` provides the JSON Schema,
validation with repair messages, and prompt guidance. The
[integrations guide](./integrations.md) shows the Vercel AI SDK, CopilotKit,
assistant-ui, and AG-UI, and the
[Next.js chat template](https://github.com/webllm/renderify/tree/main/templates/nextjs-chat)
is a working app.

## Run model-written JSX safely

```tsx
import { RenderifyFrame } from "@renderify/react";

<RenderifyFrame source={code} allowedActions={["save"]} onAction={handleAction} />;
```

The code runs in an opaque-origin [sandboxed frame](./sandboxed-frame.md): it
can use npm packages from JSPM, but it cannot read your page, and only the
action types you allow reach your app.

## Serve UIs from an MCP server

`@renderify/mcp-app` turns tool results into interactive views in MCP Apps
hosts. Start from the
[MCP server template](https://github.com/webllm/renderify/tree/main/templates/mcp-server).

## Try it without code

The [website Playground](https://webllm.github.io/renderify/playground/) renders
JSX/TSX or RuntimePlan JSON in your browser with no model and no account.

## Renderify's own prompt-to-UI pipeline

If you do not use an agent framework, `@renderify/core` and `@renderify/llm`
run the whole loop: prompt, structured generation with repair, policy checks,
and rendering.

```ts
import {
  createRenderifyApp,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultUIRenderer,
  DefaultCustomizationEngine,
  DefaultApiIntegration,
} from "@renderify/core";
import { DefaultRuntimeManager, JspmModuleLoader } from "@renderify/runtime";
import { DefaultSecurityChecker } from "@renderify/security";
import { createLLMInterpreter } from "@renderify/llm";

const config = new DefaultRenderifyConfig();
await config.load();

const app = createRenderifyApp({
  config,
  context: new DefaultContextManager(),
  llm: createLLMInterpreter({
    provider: "openai",
    providerOptions: { apiKey: "your-key" },
  }),
  codegen: new DefaultCodeGenerator(),
  runtime: new DefaultRuntimeManager({
    moduleLoader: new JspmModuleLoader(),
  }),
  security: new DefaultSecurityChecker(),
  performance: new DefaultPerformanceOptimizer(),
  ui: new DefaultUIRenderer(),
  apiIntegration: new DefaultApiIntegration(),
  customization: new DefaultCustomizationEngine(),
});

await app.start();

// Single render
const result = await app.renderPrompt("Build a welcome card");
console.log(result.html);

// Streaming render
for await (const chunk of app.renderPromptStream("Build a dashboard")) {
  if (chunk.type === "preview") {
    console.log("Preview:", chunk.html);
  }
  if (chunk.type === "final") {
    console.log("Final:", chunk.html);
  }
}

await app.stop();
```

## Work on Renderify

To run the local development Playground, the CLI, or the test suites, clone
the repository (pnpm 10.29.3 or newer):

```bash
git clone https://github.com/webllm/renderify.git
cd renderify
pnpm install
pnpm playground   # http://127.0.0.1:4317
```

The CLI renders prompts and plan files:

```bash
pnpm cli -- run "Build a welcome card"           # render a prompt and print HTML
pnpm cli -- plan "Build a welcome card"          # print the RuntimePlan JSON
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json
pnpm cli -- render-plan examples/runtime/counter-plan.json
```

## LLM Provider Configuration

Renderify supports hosted and local LLM providers out of the box. Configure via environment variables:

```bash
# OpenAI (default)
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_API_KEY=sk-... pnpm playground

# Anthropic
RENDERIFY_LLM_PROVIDER=anthropic RENDERIFY_LLM_API_KEY=sk-ant-... pnpm playground

# Google (Gemini)
RENDERIFY_LLM_PROVIDER=google RENDERIFY_LLM_API_KEY=... pnpm playground

# OpenAI Codex OAuth backend (no Codex CLI required)
pnpm cli -- auth codex login
RENDERIFY_LLM_PROVIDER=openai-codex pnpm playground
```

You can also customize the model and base URL:

```bash
RENDERIFY_LLM_PROVIDER=openai \
RENDERIFY_LLM_MODEL=gpt-5-mini \
RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1 \
RENDERIFY_LLM_API_KEY=sk-... \
pnpm playground
```

## Security Profiles

Renderify enforces security policies before any code executes. Four built-in profiles:

```bash
# Strict: tight limits, requires module integrity hashes
RENDERIFY_SECURITY_PROFILE=strict pnpm playground

# Balanced (default): moderate limits, practical for most use cases
RENDERIFY_SECURITY_PROFILE=balanced pnpm playground

# Trusted: reviewed JSX/source with hooks and package imports
RENDERIFY_SECURITY_PROFILE=trusted pnpm playground

# Relaxed: permissive limits for trusted environments
RENDERIFY_SECURITY_PROFILE=relaxed pnpm playground

# JSPM-only strict mode: strict profile + manifest/integrity + no fallback CDNs
RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE=true pnpm playground
```

See [Security Guide](./security.md) for detailed policy configuration.

### Monorepo commands

```bash
pnpm install          # Install dependencies
pnpm lint             # Lint all packages
pnpm typecheck        # Type check all packages
pnpm unit             # Run unit tests
pnpm e2e              # Run end-to-end tests
pnpm bench            # Run benchmarks
pnpm test             # Typecheck + unit tests
pnpm build            # Build all packages
pnpm format           # Auto-format code
```

## Package Overview

| Package | Purpose |
| --- | --- |
| `@renderify/react` | `<RenderifyView>`, `<RenderifyFrame>`, and `useRenderifySession` for React apps |
| `@renderify/ir` | RuntimePlan types, validation, the shared LLM schema, and repair diagnostics |
| `@renderify/runtime` | Execution engine, browser embedding, and the JSPM module loader |
| `@renderify/frame` | Sandboxed iframe for model-written JSX, TSX, and plans |
| `@renderify/security` | Security profiles and static policy checks |
| `@renderify/mcp-app` | MCP Apps server and view adapter for declarative plans |
| `@renderify/core` | Prompt-to-UI orchestration: config, codegen, plugins, LLM interface |
| `@renderify/llm` | Providers for OpenAI, Codex, Anthropic, Google, Ollama, and LM Studio |
| `@renderify/cli` | CLI commands and the development Playground server |
| `renderify` | Top-level SDK facade |

## Next Steps

- [Integrations](./integrations.md) — AI SDK, CopilotKit, assistant-ui, AG-UI, and MCP Apps
- [Sandboxed frame](./sandboxed-frame.md) — run model-written source safely
- [Architecture Overview](./architecture/index.md) — understand the full pipeline
- [Visual Architecture (Mermaid)](./architecture-visual.md) — system diagrams for data flow and package boundaries
- [RuntimePlan IR Reference](./runtime-plan-ir.md) — learn the intermediate representation
- [Security Guide](./security.md) — security policies and profiles
- [LLM Integration](./llm-integration.md) — provider configuration and structured output
- [Runtime Execution](./runtime-execution.md) — execution engine, module loading, sandboxing
- [Plugin System](./plugin-system.md) — extensibility hooks
- [CLI & Playground](./cli-playground.md) — CLI commands and playground features
- [Renderer-only website Playground](./website-playground.md) — static code editor with no LLM request
- [Website deployment](./website-deployment.md) — Fumadocs and GitHub Pages workflow
- [Browser Integration](./browser-integration.md) — embedding in web applications
- [API Reference](./api-reference.md) — complete type and function reference
- [Troubleshooting & FAQ](./troubleshooting-faq.md) — failure diagnostics and recovery checklist
- [Cookbook](./cookbook.md) — copy-paste integration patterns
- [Performance Tuning](./performance-tuning.md) — runtime knobs, CI guardrails, and optimization workflow
- [Contributing Guide](./contributing.md) — development workflow and conventions
