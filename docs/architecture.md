# Architecture Overview

This document describes the end-to-end architecture of Renderify, covering the pipeline stages, package responsibilities, data flow, and key design decisions.

## High-Level Pipeline

```
User Prompt
  │
  ▼
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  LLM Interpreter │────▶│  Code Generator  │────▶│   RuntimePlan    │
│  (OpenAI/Claude/ │     │  (JSON or TSX    │     │   (IR)           │
│   Gemini)        │     │   extraction)    │     │                  │
└─────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │  Security Policy  │
                                                │  Checker          │
                                                └────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │  Runtime Manager  │
                                                │  (Execute plan,   │
                                                │   resolve modules,│
                                                │   transpile)      │
                                                └────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │  UI Renderer      │
                                                │  (HTML generation,│
                                                │   DOM reconcile)  │
                                                └──────────────────┘
                                                          │
                                                          ▼
                                                   Rendered UI
```

## Package Dependency Graph

```
@renderify/cli
  ├── @renderify/core
  │     ├── @renderify/ir
  │     ├── @renderify/security ── @renderify/ir
  │     └── @renderify/runtime
  │           ├── @renderify/ir
  │           └── @renderify/security
  └── @renderify/llm
        ├── @renderify/core
        └── @renderify/ir
```

## Pipeline Stages in Detail

### Stage 1: LLM Interpretation

The `LLMInterpreter` interface abstracts over LLM providers. Each provider (OpenAI, Anthropic, Google) implements:

- **`generateResponse()`** — single-shot text generation
- **`generateResponseStream()`** — streaming token-by-token generation via SSE
- **`generateStructuredResponse()`** — JSON schema-constrained generation for RuntimePlan output

The pipeline first attempts structured output (requesting a RuntimePlan JSON directly from the LLM). If the structured response is invalid, it falls back to free-form text generation.

### Stage 2: Code Generation

The `DefaultCodeGenerator` converts LLM output into a `RuntimePlan`. It attempts multiple parse strategies in order:

1. **Direct RuntimePlan JSON** — the entire LLM output is valid JSON conforming to the RuntimePlan schema
2. **RuntimeNode JSON** — a JSON object representing a single node, wrapped into a plan
3. **Fenced code block extraction** — `tsx`, `jsx`, `ts`, or `js` code blocks are extracted and placed into `plan.source`
4. **Text fallback** — the raw text is wrapped as a text node

For streaming scenarios, an incremental code generation session (`createIncrementalSession`) processes LLM deltas in real-time, using FNV-1a 64-bit hashing for efficient change detection.

### Stage 3: Security Policy Check

The `DefaultSecurityChecker` validates every RuntimePlan before execution. Checks include:

- **Blocked HTML tags** (script, iframe, object, embed, etc.)
- **Module specifier allowlists** (only permitted CDN hosts and prefixes)
- **Tree depth and node count limits**
- **Execution budget validation** (maxImports, maxExecutionMs, maxComponentInvocations)
- **State model safety** (prototype pollution protection in paths)
- **Runtime source analysis** (banned patterns like `eval()`, `fetch()`, `document.cookie`)
- **Module manifest coverage** (bare specifiers must have manifest entries in strict mode)
- **Spec version compatibility**

Three built-in profiles (`strict`, `balanced`, `relaxed`) provide sensible defaults. Custom policy overrides are supported.

### Stage 4: Runtime Execution

The `DefaultRuntimeManager` is the core execution engine. It handles:

- **Node resolution** — recursively resolves `element`, `text`, and `component` nodes
- **Module loading** — resolves bare npm specifiers via `JspmModuleLoader` to JSPM CDN URLs
- **Source transpilation** — TypeScript/JSX transpiled via `@babel/standalone` through `BabelRuntimeSourceTranspiler`
- **Import rewriting** — bare specifiers in source code are rewritten to resolved CDN URLs
- **Execution budget tracking** — import counts, component invocations, and wall-clock time are tracked and enforced
- **State management** — per-plan state snapshots with action-based transitions
- **Dependency preflight** — probes all required modules before execution, with retry/timeout/CDN fallback
- **Sandbox execution** — optional Web Worker or iframe isolation for untrusted source code

### Stage 5: UI Rendering

The `DefaultUIRenderer` converts execution results to HTML:

- **RuntimeNode tree → HTML string** — with XSS sanitization and safe attribute handling
- **Preact vnode rendering** — when source modules produce Preact components, uses Preact's reconciliation
- **DOM reconciliation** — efficient diffing with keyed element matching for interactive updates
- **Event delegation** — runtime events are converted to `data-renderify-event-*` attributes with delegated listeners
- **Security sanitization** — blocks dangerous tags, strips `javascript:` URLs, validates inline styles

## Dual Input Paths

Renderify supports two fundamentally different input formats:

### Path A: Structured RuntimePlan (JSON)

```json
{
  "specVersion": "runtime-plan/v1",
  "id": "dashboard-v1",
  "version": 1,
  "root": { "type": "element", "tag": "div", "children": [...] },
  "capabilities": { "domWrite": true },
  "state": { "initial": { "count": 0 } },
  "imports": ["recharts"]
}
```

The LLM generates a JSON object conforming to the RuntimePlan schema. This path provides maximum control and deterministic behavior.

### Path B: TSX/JSX Source Code

````
```tsx
import { useState } from "preact/hooks";
import { LineChart, Line } from "recharts";

export default function Dashboard() {
  const [metric, setMetric] = useState("revenue");
  return <div>...</div>;
}
```
````

The LLM generates fenced code blocks. The codegen stage extracts the source code and wraps it in a RuntimePlan with `plan.source`. The runtime then transpiles and executes the source module.

## Streaming Architecture

The streaming pipeline (`renderPromptStream`) provides progressive UI updates:

```
LLM tokens ──▶ llm-delta chunks ──▶ preview renders ──▶ final render
```

1. **llm-delta** — each token from the LLM is emitted as a chunk
2. **preview** — at configurable intervals, the accumulated text is parsed and rendered as a preview
3. **final** — after LLM completion, the full pipeline executes and emits the final result
4. **error** — if any stage fails, an error chunk is emitted before the exception propagates

## Plugin Hook Architecture

The `CustomizationEngine` provides 10 hook points that form an interception chain:

```
beforeLLM ─▶ [LLM] ─▶ afterLLM
   ─▶ beforeCodeGen ─▶ [CodeGen] ─▶ afterCodeGen
      ─▶ beforePolicyCheck ─▶ [Security] ─▶ afterPolicyCheck
         ─▶ beforeRuntime ─▶ [Runtime] ─▶ afterRuntime
            ─▶ beforeRender ─▶ [UI] ─▶ afterRender
```

Each hook receives the current payload and can transform it before passing to the next stage. Multiple plugins are executed in registration order.

## Module Resolution Strategy

Module resolution follows a tiered approach:

1. **Module manifest lookup** — if the plan includes a `moduleManifest`, bare specifiers are resolved to their `resolvedUrl`
2. **Compatibility aliases** — built-in aliases map `react`/`react-dom` to `preact/compat`, and include pinned versions for `recharts`
3. **JSPM CDN resolution** — bare specifiers are resolved to `https://ga.jspm.io/npm:{specifier}`
4. **Fallback CDNs** — on failure, tries configured fallback bases (default: `esm.sh`)
5. **Asset proxying** — CSS imports become style-injection proxy modules; JSON imports become ESM default exports

Node.js builtins and unsupported schemes (`file://`, `jsr:`) are rejected deterministically.

## Browser Source Execution Model

When a RuntimePlan includes a `source` module, the execution flow is:

```
source.code
  ──▶ Babel transpile (TSX → JS)
     ──▶ es-module-lexer (extract imports)
        ──▶ Rewrite bare imports to CDN URLs
           ──▶ Create blob: URL for module
              ──▶ Dynamic import()
                 ──▶ Extract default export
                    ──▶ Render as Preact component (or RuntimeNode tree)
```

Optional sandbox modes (`sandbox-worker`, `sandbox-iframe`) isolate execution in a separate context with configurable timeouts and fail-closed behavior.

## Key Design Decisions

### Why JSPM instead of bundling?

JSPM provides browser-native ESM modules from npm packages without a build step. This eliminates the need for a backend compiler while giving access to the npm ecosystem. The tiered compatibility contract (guaranteed aliases + best-effort resolution) provides predictable behavior.

### Why Preact instead of React?

Preact is ~3KB (vs React's ~45KB), loads faster from CDN, and provides full React API compatibility via `preact/compat`. The compatibility bridge maps all React/ReactDOM imports to Preact equivalents transparently.

### Why Babel standalone for transpilation?

`@babel/standalone` runs entirely in the browser, supporting TypeScript and JSX without any backend. It's loaded on demand only when the plan includes source modules.

### Why security-first execution?

Every RuntimePlan passes through security checks before any code runs. This is critical because LLM output is fundamentally untrusted — the model could generate `<script>` tags, `eval()` calls, or unsafe network requests. The policy framework provides defense-in-depth at multiple levels.

### Why dual input paths?

Structured RuntimePlan JSON gives precise control for production systems. TSX/JSX code blocks are more natural for LLMs and enable richer interactivity. Supporting both paths maximizes flexibility across different LLM capabilities and use cases.
