# Renderify

> Runtime-first UI: interpret -> plan -> policy-check -> execute -> render, without build-per-change for product UI iteration.

Renderify is a runtime-first UI engine that executes LLM-generated JSX/TSX directly in the browser via Babel and JSPM, with no build or publish step.

## Why Renderify

Most AI UI stacks stop at generation + preview, then require build/deploy to become usable.

Renderify focuses on:

- Runtime-direct rendering (validated plans execute immediately)
- Controlled dynamic execution (policy-first, not unrestricted eval)
- Stateful runtime transitions (event -> actions -> updated UI)
- Traceable rollback/replay with audit logs
- Swappable adapters (LLM, module loader, renderer, plugins)

## Runtime Pipeline

```mermaid
flowchart TD
    A["Prompt / Context"] --> B["LLM Interpreter"]
    B --> C["Code Generator"]
    C --> D["Runtime Plan (IR)"]
    D --> E["Security Policy Checker"]
    E --> F["Runtime Executor"]
    F --> G["UI Renderer"]
    F --> H["JSPM Module Loader"]
    H --> I["JSPM CDN / SystemJS"]
    J["Customization Plugins"] --> B
    J --> C
    J --> E
    J --> F
    J --> G
```

## Implemented Capabilities

- Versioned plan registry with rollback
- Execution audit log with replay
- Stateful plan model:
  - `state.initial`
  - `state.transitions[eventType] -> actions[]`
  - action types: `set`, `increment`, `toggle`, `push`
  - value sources: `state.*`, `event.*`, `context.*`, `vars.*`
- Runtime quotas and limits:
  - `maxImports`
  - `maxExecutionMs`
  - `maxComponentInvocations`
- Runtime protocol contract:
  - `specVersion` (default `runtime-plan/v1`)
  - `moduleManifest` for deterministic module resolution
- JSX runtime modes:
  - `source.runtime: "renderify"` for RuntimeNode-oriented execution
  - `source.runtime: "preact"` for hooks + React-compatible component rendering
- Runtime sandbox profile:
  - `executionProfile: "isolated-vm"` for VM-isolated sync component execution
  - fail-closed by default when isolation runtime is unavailable
- LLM structured contract:
  - prompt flow prefers structured `runtime-plan` output
  - auto fallback to text generation when structured payload is invalid
- TSX/JSX runtime source pipeline:
  - `codegen` extracts fenced `tsx/jsx/ts/js` blocks into `plan.source`
  - runtime transpiles source via Babel (browser `@babel/standalone`)
  - import specifiers are resolved through JSPM loader strategy
- Real OpenAI provider adapter (`@renderify/llm-openai`) with structured JSON schema requests
- Security policy checks for state transitions and quota requests
- Runtime source static policy checks (blocked patterns, dynamic import policy, source import count)
- Streaming prompt pipeline (`renderPromptStream`) with progressive preview updates
- Preact DOM reconciliation path for runtime source modules (diff-based UI updates)
- Security profiles: `strict | balanced | relaxed`
- Tenant quota governance:
  - max executions per minute
  - max concurrent executions
  - throttled audit status on quota exceed
  - enforced in long-running runtime process (e.g. playground/server mode)
- RuntimePlan structural guards for safer plan ingestion
- Browser runtime playground (`renderify playground`) for live prompt/plan/event/state/history flows
- CLI persisted history (`.renderify/session.json`)
- Unit tests for `ir/codegen/security/runtime/core`
- CI matrix (`Node 22 + Node 24`) for typecheck/unit + quality gates
- PR changeset enforcement for release-relevant package changes
- Benchmark workflow with JSON artifacts uploaded per CI run

## Monorepo Commands

```bash
# install
pnpm install

# quality + tests
pnpm lint
pnpm typecheck
pnpm unit
pnpm e2e
pnpm bench
pnpm test

# package quality and builds
pnpm validate
pnpm build

# auto-format
pnpm format
```

## CLI Quick Start

```bash
# Render prompt and print HTML
pnpm cli -- run "Build a welcome card"

# Print RuntimePlan JSON
pnpm cli -- plan "Build a welcome card"

# Execute RuntimePlan file
pnpm cli -- render-plan examples/runtime/counter-plan.json

# Dispatch runtime event to a stored plan
pnpm cli -- event <planId> increment '{"delta":1}'

# Inspect runtime state and history
pnpm cli -- state <planId>
pnpm cli -- history

# Rollback / replay
pnpm cli -- rollback <planId> <version>
pnpm cli -- replay <traceId>

# Browser playground
pnpm playground

# Optional security/tenant env
RENDERIFY_SECURITY_PROFILE=strict pnpm playground
RENDERIFY_MAX_EXECUTIONS_PER_MINUTE=60 RENDERIFY_MAX_CONCURRENT_EXECUTIONS=2 pnpm playground
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false pnpm playground

# Optional LLM provider env
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_API_KEY=<your_key> pnpm playground
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_MODEL=gpt-4.1-mini RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1 pnpm playground

# Runtime protocol/runtime safety env
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true pnpm playground
RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK=false pnpm playground
RENDERIFY_RUNTIME_SPEC_VERSIONS=runtime-plan/v1 pnpm playground

# Force text/TSX generation path instead of structured RuntimePlan
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false pnpm playground
```

## Killer Demo

```bash
# start playground
pnpm playground
```

Then open the playground page and run this prompt:

```text
Build an analytics dashboard with a chart and KPI toggle buttons
```

The playground now uses streaming prompt rendering (`/api/prompt-stream`), so you'll see incremental preview updates before final UI completion.

![Renderify streaming demo](docs/assets/renderify-streaming-demo.gif)

## Release Flow

```bash
# CI enforces that package changes include a `.changeset/*.md` entry
# run this when your PR changes package behavior/API

# add a release note for changed packages
pnpm changeset

# apply versions/changelog updates
pnpm version-packages

# publish packages
pnpm release
```

Release automation is gated by CI success on `main` and uses Changesets to either open a version PR or publish to npm with provenance enabled.

## Programmatic Example

```ts
import { createRenderifyApp } from "@renderify/core";
import { DefaultContextManager } from "@renderify/core";
import { DefaultPerformanceOptimizer } from "@renderify/core";
import { DefaultRenderifyConfig } from "@renderify/config";
import { DefaultLLMInterpreter } from "@renderify/llm-interpreter";
import { DefaultCodeGenerator } from "@renderify/codegen";
import { DefaultRuntimeManager } from "@renderify/runtime";
import { JspmModuleLoader } from "@renderify/runtime-jspm";
import { DefaultSecurityChecker } from "@renderify/security";
import { DefaultUIRenderer } from "@renderify/ui";

const app = createRenderifyApp({
  config: new DefaultRenderifyConfig(),
  context: new DefaultContextManager(),
  llm: new DefaultLLMInterpreter(),
  codegen: new DefaultCodeGenerator(),
  runtime: new DefaultRuntimeManager({
    moduleLoader: new JspmModuleLoader(),
  }),
  security: new DefaultSecurityChecker(),
  performance: new DefaultPerformanceOptimizer(),
  ui: new DefaultUIRenderer(),
});

await app.start();

const planResult = await app.renderPrompt("Build a runtime counter");
await app.dispatchEvent(planResult.plan.id, {
  type: "increment",
  payload: { delta: 1 },
});

console.log(app.getPlanState(planResult.plan.id));
await app.stop();
```

## Package Topology

| Package | Responsibility |
| --- | --- |
| `@renderify/ir` | Runtime IR contracts (plan/node/state/action/event/capabilities) |
| `@renderify/security` | Policy guardrails for plan, transitions, and module capabilities |
| `@renderify/runtime` | Runtime execution engine and state transition evaluator |
| `@renderify/runtime-jspm` | JSPM/SystemJS module loader adapter |
| `@renderify/ui` | Runtime HTML/DOM renderer |
| `@renderify/core` | End-to-end pipeline orchestration and lifecycle APIs |
| `@renderify/codegen` | LLM output -> RuntimePlan conversion |
| `@renderify/llm-interpreter` | LLM abstraction layer |
| `@renderify/llm-openai` | OpenAI-backed `LLMInterpreter` adapter |
| `@renderify/config` | Runtime/security config source |
| `@renderify/cli` | CLI + browser playground |

## Integration Docs

- Runtime contracts: `docs/architecture/runtime-contracts.md`
- Framework design: `docs/architecture/framework-design.md`
- Implementation status: `docs/architecture/implementation-status.md`
- Plugin/loader integration guide: `docs/architecture/plugin-loader-integration.md`

## Browser Examples

- Runtime plan flow: `examples/runtime/browser-runtime-example.html`
- TSX runtime flow (Babel + JSPM): `examples/runtime/browser-tsx-jspm-example.html`
- Recharts + Preact RuntimePlan: `examples/runtime/recharts-dashboard-plan.json`

## Next Focus

- Production-grade sandbox isolation boundary (Worker/VM execution profile)
- Additional provider adapters and reliability strategies (retry, backoff, circuit breaking)
- Multi-tenant policy profile presets and quota governance

## License

MIT
