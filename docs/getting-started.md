# Getting Started

Renderify is a runtime-first dynamic renderer that lets LLMs produce real, interactive UI on the fly. It bridges the gap between "LLM can generate code" and "users can see and interact with that UI instantly" — with inline transpilation, JSPM package support, and security-governed execution.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 10.29.3

## Installation

```bash
# Clone the repository
git clone https://github.com/unadlib/renderify.git
cd renderify

# Install dependencies
pnpm install
```

## Quick Start

### 1. Run the Playground

The fastest way to explore Renderify is through the browser playground:

```bash
pnpm playground
```

Open `http://127.0.0.1:4317` in your browser. Try a prompt like:

```
Build an analytics dashboard with a LineChart from recharts and KPI toggle buttons
```

Use `Render Prompt` for one-shot execution, or `Stream Prompt` to see incremental preview updates followed by the final interactive result.

### 2. CLI Usage

```bash
# Render a prompt and print HTML
pnpm cli -- run "Build a welcome card"

# Print the RuntimePlan JSON (inspect LLM output before rendering)
pnpm cli -- plan "Build a welcome card"

# Probe a RuntimePlan file for compatibility (no execution)
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json

# Execute a RuntimePlan JSON file
pnpm cli -- render-plan examples/runtime/counter-plan.json
```

### 3. Programmatic Usage

The minimal embed path uses `@renderify/runtime` and `@renderify/ir`:

```ts
import { renderPlanInBrowser } from "@renderify/runtime";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
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
```

### 4. Full Pipeline with LLM

For the complete prompt-to-UI pipeline:

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
  llm: createLLMInterpreter({ provider: "openai", providerOptions: { apiKey: "your-key" } }),
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

## LLM Provider Configuration

Renderify supports three LLM providers out of the box. Configure via environment variables:

```bash
# OpenAI (default)
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_API_KEY=sk-... pnpm playground

# Anthropic
RENDERIFY_LLM_PROVIDER=anthropic RENDERIFY_LLM_API_KEY=sk-ant-... pnpm playground

# Google (Gemini)
RENDERIFY_LLM_PROVIDER=google RENDERIFY_LLM_API_KEY=... pnpm playground
```

You can also customize the model and base URL:

```bash
RENDERIFY_LLM_PROVIDER=openai \
RENDERIFY_LLM_MODEL=gpt-4.1-mini \
RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1 \
RENDERIFY_LLM_API_KEY=sk-... \
pnpm playground
```

## Security Profiles

Renderify enforces security policies before any code executes. Three built-in profiles:

```bash
# Strict: tight limits, requires module integrity hashes
RENDERIFY_SECURITY_PROFILE=strict pnpm playground

# Balanced (default): moderate limits, practical for most use cases
RENDERIFY_SECURITY_PROFILE=balanced pnpm playground

# Relaxed: permissive limits for trusted environments
RENDERIFY_SECURITY_PROFILE=relaxed pnpm playground
```

See [Security Guide](./security.md) for detailed policy configuration.

## Monorepo Commands

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

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/ir` | `@renderify/ir` | Intermediate representation: plan/node/state/action types |
| `packages/runtime` | `@renderify/runtime` | Execution engine, JSPM loader, browser embed API |
| `packages/security` | `@renderify/security` | Security policy profiles and static checks |
| `packages/core` | `@renderify/core` | Orchestration facade: config, codegen, plugins, LLM interface |
| `packages/llm` | `@renderify/llm` | LLM provider implementations (OpenAI, Anthropic, Google) |
| `packages/cli` | `@renderify/cli` | CLI commands and browser playground server |

## Next Steps

- [Architecture Overview](./architecture.md) — understand the full pipeline
- [RuntimePlan IR Reference](./runtime-plan-ir.md) — learn the intermediate representation
- [Security Guide](./security.md) — security policies and profiles
- [LLM Integration](./llm-integration.md) — provider configuration and structured output
- [Runtime Execution](./runtime-execution.md) — execution engine, module loading, sandboxing
- [Plugin System](./plugin-system.md) — extensibility hooks
- [CLI & Playground](./cli-playground.md) — CLI commands and playground features
- [Browser Integration](./browser-integration.md) — embedding in web applications
- [API Reference](./api-reference.md) — complete type and function reference
- [Contributing Guide](./contributing.md) — development workflow and conventions
