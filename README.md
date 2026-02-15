# Renderify

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/renderify.svg)
![license](https://img.shields.io/npm/l/renderify)

> LLM generates JSX/TSX → browser renders it directly at runtime — no backend build server, no deploy step, JSPM package support with an explicit compatibility contract.
> Renderify is a runtime-first dynamic renderer that lets LLMs produce real, interactive UI on the fly. It bridges the gap between "LLM can generate code" and "users can see and interact with that UI instantly" — with inline transpilation via `@babel/standalone`, and no backend compiler/deploy pipeline in the loop.

## The Problem

LLMs are increasingly capable of generating UI code, but **there is no good way to render that output directly in the browser**:
| Existing Approach | Limitation |
| --- | --- |
| **v0 / Bolt.new** | Requires a full build backend (Next.js compile + deploy). Not embeddable as a runtime in your own app. |
| **Streamlit / Gradio** | Python-based, server-rendered. Not a frontend runtime. |
| **MCP UI** | Limited to Markdown + a small fixed component set. Cannot express arbitrary UI. |
| **Anthropic Artifacts** | Closed implementation, not open-source, not embeddable. |
| **JSON schema renderers (A2UI, json-render)** | LLM fills parameters into a predefined component catalog. Cannot express anything outside the schema. |
| **Sandpack / WebContainers** | Full in-browser bundlers — powerful but heavyweight, not optimized for the LLM → UI hot path. |
**The missing piece**: a lightweight, security-governed runtime where LLMs output JSX/TSX (or structured plans) and the browser renders it immediately — with broad browser-ESM npm access via JSPM, without any backend compile step.

## What Renderify Does

```
LLM output (JSX/TSX or structured plan)
  → CodeGen (parse + normalize)
    → Security policy check (before any execution)
      → Runtime execution (Babel transpile + JSPM module resolution)
        → Rendered UI in the browser
```

- **Zero-build rendering**: LLM-generated JSX/TSX runs directly in the browser via `@babel/standalone` + JSPM CDN. No backend build server, no deploy step, no server round-trip.
- **JSPM package support (tiered contract)**: Compatibility aliases (`preact`/`react` bridge, `recharts`) are guaranteed; pure browser ESM packages (for example `lodash-es`, `date-fns`, `@mui/material`) are best-effort. Node.js builtins and unsupported schemes are rejected deterministically.
- **Security-first execution**: Every plan passes through a policy checker (blocked tags, module allowlists, tree depth limits, execution budgets) _before_ any code runs. Three built-in profiles: `strict`, `balanced`, `relaxed`.
- **JSPM-only strict preset**: Set `RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE=true` to force strict profile + manifest/integrity enforcement + preflight fail-fast + no fallback CDNs.
- **Dual input paths**: Accepts both structured JSON RuntimePlans (for precise LLM structured output) and raw TSX/JSX code blocks (for natural LLM text generation).
- **LLM is optional**: You can use Renderify as a renderer-only runtime by supplying RuntimePlan/source from your own backend or model pipeline.
- **Streaming-first rendering**: `renderPromptStream` emits `llm-delta` / `preview` / `final` chunks so chat UIs can progressively render.
- **Pluggable at every stage**: 10 hook points (`beforeLLM`, `afterCodeGen`, `beforeRender`, etc.) let you inject custom logic without forking the core.

## Who This Is For

- **LLM chat / agent platforms** that need to render dynamic UI from model output (dashboards, forms, cards, data visualizations)
- **AI Agent toolchains** — an Agent analyzes user data and dynamically generates an interactive dashboard or operation interface, rather than just returning text
- **Low-code / No-code AI backends** — users describe intent in natural language, the LLM generates a runnable UI component on the fly
- **Dynamic forms & approval flows** — generate context-aware forms at runtime, more flexible than JSON Schema renderers
- **Rapid prototyping** workflows where you want to go from prompt → rendered UI in seconds, not minutes
- **Any application** that needs to safely render untrusted, dynamically-generated UI in the browser

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

- Runtime plan model with optional `state` (when provided, `state.initial` is required)
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
  - browser source sandbox with `sandbox-worker` / `sandbox-iframe` / `sandbox-shadowrealm` execution profiles
  - runtime-level controls: mode / timeout / fail-closed
- LLM structured contract:
  - prompt flow prefers structured `runtime-plan` output
  - auto fallback to text generation when structured payload is invalid
- TSX/JSX runtime source pipeline:
  - `codegen` extracts fenced `tsx/jsx/ts/js` blocks into `plan.source`
  - runtime transpiles source via Babel (browser `@babel/standalone`)
  - import specifiers are resolved via `es-module-lexer` + JSPM loader strategy (less regex fragility)
  - browser runtime rewrites source module graphs so transitive bare imports resolve at runtime
- Dependency preflight before execution:
  - probes `imports`, `component modules`, and `source imports`
  - optional fail-fast mode for CI/production gates
  - retry + timeout + multi-CDN fallback for remote module fetches
- Browser asset module proxying:
  - CSS imports are converted to runtime style-injection proxy modules
  - JSON imports are converted to ESM default exports
- React ecosystem compatibility bridge:
  - `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` are mapped to `preact/compat` equivalents
  - enables direct runtime rendering for React-first packages (e.g. `recharts`, `@mui/material`)
- LLM provider package (`@renderify/llm`) with built-in OpenAI, Anthropic, and Google providers
- Runtime source static policy checks (blocked patterns, dynamic import policy, source import count)
- Streaming prompt pipeline (`renderPromptStream`) with progressive preview updates
- Preact DOM reconciliation path for runtime source modules (diff-based UI updates)
- Security profiles: `strict | balanced | relaxed`
- RuntimePlan structural guards for safer plan ingestion
- One-line embed API: `renderPlanInBrowser(plan, { target })`
- Browser runtime playground (`renderify playground`) for live prompt/plan/stream/probe flows
- Unit tests for `ir/core/runtime`
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

# Probe RuntimePlan compatibility (policy + runtime preflight diagnostics)
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json
# side-effect free: does not execute plan source/component logic

# Execute RuntimePlan file
pnpm cli -- render-plan examples/runtime/counter-plan.json

# Browser playground
pnpm playground

# Optional security env
RENDERIFY_SECURITY_PROFILE=strict pnpm playground
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false pnpm playground

# Optional LLM provider env
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_API_KEY=<your_key> pnpm playground
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_MODEL=gpt-4.1-mini RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1 pnpm playground
RENDERIFY_LLM_PROVIDER=anthropic RENDERIFY_LLM_API_KEY=<your_key> pnpm playground
RENDERIFY_LLM_PROVIDER=anthropic RENDERIFY_LLM_MODEL=claude-3-5-sonnet-latest RENDERIFY_LLM_BASE_URL=https://api.anthropic.com/v1 pnpm playground
RENDERIFY_LLM_PROVIDER=google RENDERIFY_LLM_API_KEY=<your_key> pnpm playground
RENDERIFY_LLM_PROVIDER=google RENDERIFY_LLM_MODEL=gemini-2.0-flash RENDERIFY_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta pnpm playground

# Runtime protocol/runtime safety env
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true pnpm playground
RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK=false pnpm playground
RENDERIFY_RUNTIME_SPEC_VERSIONS=runtime-plan/v1 pnpm playground
RENDERIFY_RUNTIME_PREFLIGHT=true RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST=true pnpm playground
RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS=12000 RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES=2 pnpm playground
RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS=https://esm.sh,https://cdn.jsdelivr.net pnpm playground
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=shadowrealm RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000 pnpm playground
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true pnpm playground

# Force text/TSX generation path instead of structured RuntimePlan
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false pnpm playground
```

### Playground Hash Deep-Link

The playground can auto-render from URL hash payloads:

- `#plan64=<base64url(RuntimePlan JSON)>`
- `#jsx64=<base64url(JSX source)>`
- Also supports `#tsx64`, `#js64`, `#ts64`, with optional `runtime`, `exportName`, and `manifest64`.

For bare imports (for example `import { LineChart } from "recharts"`), playground now auto-hydrates `moduleManifest` from JSPM resolution. You can still pass `manifest64` to pin exact mappings.

```bash
PLAN64=$(node -e 'const plan={specVersion:"runtime-plan/v1",id:"hash_demo",version:1,root:{type:"element",tag:"div",children:[{type:"text",value:"Hello from hash plan"}]},capabilities:{}};process.stdout.write(Buffer.from(JSON.stringify(plan),"utf8").toString("base64url"));')
open "http://127.0.0.1:4317/#plan64=${PLAN64}"
```

```bash
JSX64=$(node -e 'const code="export default function App(){ return <div style={{ padding: 16 }}>Hello hash JSX</div>; }";process.stdout.write(Buffer.from(code,"utf8").toString("base64url"));')
open "http://127.0.0.1:4317/#jsx64=${JSX64}&runtime=preact"
```

## Killer Demo

```bash
# start playground
pnpm playground
```

Then open the playground page and run this prompt:

```text
Build an analytics dashboard with a LineChart from recharts and KPI toggle buttons
```

The playground now uses streaming prompt rendering (`/api/prompt-stream`), so you'll see incremental preview updates before final UI completion.

![Renderify streaming demo](docs/assets/renderify-streaming-demo.gif)

## Programmatic Example

Core quick embed path (`ir + runtime`, default security checker included):

```ts
import { renderPlanInBrowser } from "@renderify/runtime";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = /* LLM generated RuntimePlan */;

await renderPlanInBrowser(plan, { target: "#mount" });
```

## Renderer-only Usage (No Built-in LLM)

You can skip `@renderify/llm` entirely and pass plans from any external source (your backend, another SDK, or a different model provider):

```ts
import { renderPlanInBrowser } from "renderify";

const plan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only_demo",
  version: 1,
  root: {
    type: "element",
    tag: "div",
    children: [{ type: "text", value: "Hello from BYO plan" }],
  },
  capabilities: { domWrite: true },
};

await renderPlanInBrowser(plan, { target: "#mount" });
```

### Renderer-only TSX + Dependency Package (JSPM)

```ts
import { renderPlanInBrowser } from "renderify";

const tsxPlan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only_tsx_datefns",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "div",
    children: [{ type: "text", value: "Loading..." }],
  },
  source: {
    language: "tsx",
    runtime: "renderify",
    code: [
      "import { format } from \"https://ga.jspm.io/npm:date-fns@4.1.0/format.js\";",
      "",
      "export default function App() {",
      "  return <section>Today: {format(new Date(), \"yyyy-MM-dd\")}</section>;",
      "}",
    ].join("\n"),
  },
};

await renderPlanInBrowser(tsxPlan, { target: "#mount" });
```

## Package Topology

| Package               | Responsibility                                                   |
| --------------------- | ---------------------------------------------------------------- |
| `renderify`           | Official top-level SDK facade (recommended app entry)            |
| `@renderify/ir`       | Runtime IR contracts (plan/node/state/action/event/capabilities) |
| `@renderify/runtime`  | Runtime execution engine + JSPM loader + one-line embed API      |
| `@renderify/security` | Policy profiles + plan/module/source static checks               |
| `@renderify/core`     | Legacy orchestration facade (optional compatibility layer)       |
| `@renderify/llm`      | LLM provider package (OpenAI + Anthropic + Google)               |
| `@renderify/cli`      | CLI + browser playground                                         |

## Integration Docs

- Architecture overview: `docs/architecture.md`
- RuntimePlan IR reference: `docs/runtime-plan-ir.md`
- Runtime execution engine: `docs/runtime-execution.md`
- Dependency verification model: `docs/runtime-execution.md#verification-model`
- Browser embedding: `docs/browser-integration.md`
- Security guide: `docs/security.md`
- Plugin system: `docs/plugin-system.md`

## Browser Examples

- Runtime plan flow: `examples/runtime/browser-runtime-example.html`
- TSX runtime flow (Babel + JSPM): `examples/runtime/browser-tsx-jspm-example.html`
- Recharts + Preact RuntimePlan: `examples/runtime/recharts-dashboard-plan.json`
- Killer demo: one-line chat dashboard embed: `examples/killer/one-line-chat-dashboard.html`
- Killer demo: one-line form/state/date-fns embed: `examples/killer/one-line-chat-form.html`
- Killer demo: one-line worker-sandbox source embed: `examples/killer/one-line-sandbox-worker.html`

## Technical Highlights

Beyond the end-to-end pipeline, several components have standalone value:

- **RuntimePlan IR** — a standardized intermediate representation for "LLM-generated interactive UI." Even outside Renderify, the IR design provides a reusable schema for any system that needs to describe dynamic, composable UI from model output.
- **Security policy framework** — a systematic approach to executing untrusted dynamic code: blocked tags, module allowlists, execution budgets, and source pattern analysis. The policy model is reusable for any browser-side dynamic code execution scenario.
- **Browser ESM module graph materialization** — the `fetch → rewrite imports → blob URL` pipeline solves a problem browser standards have not natively addressed (bare specifiers are not usable in browsers). This module loading strategy can be extracted as an independent utility.

## Roadmap

**Next — Ecosystem expansion**

- Additional LLM provider adapters (local models)
- Reliability strategies (retry, backoff, circuit breaking)
- Pre-built component themes and layout primitives
- Framework adapter plugins (Vue, Svelte, Solid)

## License

MIT
