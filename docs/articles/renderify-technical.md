# Renderify: A Runtime Engine for Rendering LLM-Generated UI Instantly in the Browser

Repo: [github.com/webllm/renderify](https://github.com/webllm/renderify)

## Introduction

As large language models (LLMs) advance rapidly, AI can now generate structurally complete and logically sound UI code. Yet a key engineering question remains open: **how do you safely and efficiently render LLM-generated UI directly in the browser — without any backend compilation or deployment pipeline?**

Existing approaches each have limitations: v0/Bolt.new rely on a full Next.js compilation backend; Streamlit/Gradio are Python-based and server-rendered; Anthropic Artifacts is closed-source and non-embeddable; JSON Schema renderers can only express a predefined component set; Sandpack/WebContainers are powerful but heavyweight.

**Renderify** was built to fill this gap. It is a runtime-first dynamic rendering engine that transpiles, sandboxes, and renders LLM-generated JSX/TSX (or structured JSON plans) directly in the browser as interactive UI — with zero build steps, zero server-side compilation, and zero deployment pipeline.

```
LLM Output (JSX/TSX or Structured Plan)
  → Code Generator (parse + normalize)
    → Security Policy Check (intercept before execution)
      → Runtime Execution (Babel transpilation + JSPM module resolution)
        → Interactive UI rendered in the browser
```

## Industry Landscape (as of 2026-02-16)

Before discussing Renderify's differentiation, it helps to establish a common framework. The diagram below breaks the "LLM → UI" path into six stages:

```
User Intent
  -> [A] LLM generates code / description
    -> [B] Code parsing / transformation / orchestration
      -> [C] Security checks + sandboxing
        -> [D] Browser module resolution (bare import -> URL)
          -> [E] Runtime execution + DOM rendering
            -> [F] State management + interaction
```

Definitions:

- **Open Source**: Whether the core SDK/runtime has public source code (the platform service itself may be closed-source).
- **Embeddable**: Whether it can be integrated as a capability into your own application, rather than used only within the vendor's hosted product.
- **Stages Covered**: Represents the typical primary path, not the full capability boundary.

| Solution              | Stages Covered (typical)      | Core Path                                                       | Open Source                                                        | Embeddable                     |
| --------------------- | ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| v0 (Vercel)           | A→E (backend build path)      | LLM → Next.js compile/deploy                                    | Platform closed-source, SDK open-source                            | ✅ (Platform API/SDK)          |
| Bolt.new (StackBlitz) | A→E (WebContainers path)      | LLM → WebContainers → full Node.js                              | Partial (frontend open-source, WebContainers engine closed-source) | Limited (primarily a product)  |
| Anthropic Artifacts   | A→E (private sandbox)         | LLM → private render sandbox                                    | ❌                                                                 | ❌                             |
| Vercel AI SDK         | A + E (+ experimental RSC)    | LLM orchestration → framework UI                                | ✅                                                                 | ✅ (multiple frameworks)       |
| AI.JSX                | A→B                           | LLM selects/orchestrates predefined components                  | ✅                                                                 | ✅                             |
| llm-ui                | E                             | LLM text → Markdown/JSON components                             | ✅                                                                 | ✅                             |
| Gen-UI-Lang           | A→B                           | LLM → DSL → multi-target output                                 | ✅                                                                 | ✅                             |
| Thesys GenUI          | A→E                           | LLM → structured DSL/API → React render layer                   | Partial (SDK/examples open-source)                                 | ✅ (primarily React SDK)       |
| Sandpack              | D→E                           | Predefined code → iframe bundler execution                      | ✅                                                                 | ✅                             |
| WebContainers         | D→E                           | In-browser Node.js/WASM environment                             | Partial                                                            | ✅ (provides embed API)        |
| E2B                   | C→E                           | Code → remote micro VM execution                                | Partial (SDK open-source)                                          | ✅ (typically requires server) |
| Renderify             | **B→F (core) + A (optional)** | LLM/external input → IR → security policy → Babel/JSPM → render | ✅                                                                 | ✅                             |

From this perspective, Renderify's positioning is more precisely described as:

- A browser-runtime-centric, locally embeddable execution chain covering stages **B→F**.
- **Stage A is optional** — you can plug in `@renderify/llm`, or supply a RuntimePlan from any external system.

## Core Architecture

### Monorepo Package Topology

Renderify is organized as a monorepo using pnpm workspaces + Turborepo, consisting of seven packages with clearly separated responsibilities:

| Package               | Responsibility                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `@renderify/ir`       | Intermediate representation — RuntimePlan/Node/State/Action type contracts                  |
| `@renderify/security` | Security policy engine — profile configuration, static analysis, module allowlists          |
| `@renderify/runtime`  | Runtime execution engine — transpilation, module loading, sandboxed execution, UI rendering |
| `@renderify/core`     | Orchestration layer — RenderifyApp full pipeline, streaming, plugin system                  |
| `@renderify/llm`      | LLM provider abstraction — OpenAI/Anthropic/Google/Ollama/LMStudio                          |
| `renderify`           | Top-level SDK facade — the recommended application entry point                              |
| `@renderify/cli`      | CLI tooling + browser Playground                                                            |

Package dependencies form a clean directed acyclic graph (DAG). `@renderify/ir` is a leaf node with no internal dependencies; all other packages build upon it layer by layer.

### Five-Stage Pipeline

The rendering pipeline consists of five strictly ordered stages:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  LLM Interpreter │────▶│  Code Generator  │────▶│   RuntimePlan    │
│  (OpenAI/Claude/ │     │  (JSON or TSX    │     │   (IR)           │
│   Gemini)        │     │   extraction)    │     │                  │
└──────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  Security Policy │
                                                  │  Checker         │
                                                  └────────┬─────────┘
                                                           │
                                                           ▼
                                                 ┌───────────────────┐
                                                 │  Runtime Manager  │
                                                 │  (execute plan,   │
                                                 │   resolve modules,│
                                                 │   transpile)      │
                                                 └─────────┬─────────┘
                                                           │
                                                           ▼
                                                 ┌───────────────────┐
                                                 │  UI Renderer      │
                                                 │  (HTML generation,│
                                                 │   DOM reconcile)  │
                                                 └───────────────────┘
```

## RuntimePlan: The Unified Intermediate Representation

RuntimePlan is the core contract of the entire system, serving as a stable interface between all pipeline stages. Regardless of the LLM's output format, everything is normalized into a RuntimePlan before flowing through security checks, runtime execution, and UI rendering.

### Type Structure

```typescript
// Three node types compose the UI tree
type RuntimeNode =
  | RuntimeTextNode // Text node: { type: "text", value: string }
  | RuntimeElementNode // Element node: { type: "element", tag: string, props?, children? }
  | RuntimeComponentNode; // Component node: { type: "component", module: string, props?, children? }

// Complete RuntimePlan structure
interface RuntimePlan {
  specVersion?: "runtime-plan/v1";
  id: string;
  version: number;
  root: RuntimeNode; // Declarative UI tree (required)
  source?: RuntimeSourceModule; // JSX/TSX source code module
  imports?: string[]; // npm dependency declarations
  state?: RuntimeStateModel; // State model
  capabilities?: RuntimeCapabilities; // Capability declarations
  moduleManifest?: RuntimeModuleManifest; // Module resolution manifest
}
```

### Dual Input Paths

Renderify supports two fundamentally different input formats, both of which converge at the same security check and execution pipeline:

**Path A: Structured RuntimePlan JSON**

The LLM generates a structured RuntimePlan directly via JSON Schema constraints. This path offers maximum control and deterministic behavior, making it ideal for production systems.

```json
{
  "specVersion": "runtime-plan/v1",
  "id": "dashboard-v1",
  "version": 1,
  "root": {
    "type": "element",
    "tag": "div",
    "children": [{ "type": "text", "value": "Hello World" }]
  },
  "capabilities": { "domWrite": true }
}
```

**Path B: TSX/JSX Source Code**

The LLM generates free-form text containing code blocks. The code generation stage extracts the source code and wraps it as a RuntimePlan with a `source` field; the runtime then transpiles and executes it.

```tsx
import { useState } from "preact/hooks";
import { LineChart, Line } from "recharts";

export default function Dashboard() {
  const [metric, setMetric] = useState("revenue");
  return <div>...</div>;
}
```

This dual-path design maximizes flexibility — structured JSON suits scenarios that demand precise control, while TSX/JSX code blocks feel more natural for LLMs and can express richer interactive logic.

## Security: Defense in Depth

When LLMs generate code, security is paramount. An LLM may produce `<script>` tags, `eval()` calls, or unsafe network requests. Renderify employs multiple independent defense layers, enforcing strict security policies before any code executes.

### Three Security Profiles

| Policy             | Strict   | Balanced (default) | Relaxed |
| ------------------ | -------- | ------------------ | ------- |
| Max tree depth     | 8        | 12                 | 24      |
| Max node count     | 250      | 500                | 2,000   |
| Max source size    | 20KB     | 80KB               | 200KB   |
| Max imports        | 80       | 200                | 1,000   |
| Max execution time | 5s       | 15s                | 60s     |
| Manifest required  | Yes      | Yes                | No      |
| Module integrity   | Required | No                 | No      |
| Dynamic imports    | Blocked  | Blocked            | Allowed |

### Seven Defense Layers

1. **Static pattern analysis**: Regex-based detection of dangerous source patterns (`eval(`, `new Function(`, `fetch(`, `document.cookie`, `localStorage`, `child_process`, etc.), plus path-traversal detection on module specifiers (including encoded variants).
2. **Structural limits**: Tree depth, node count, source byte size.
3. **Tag blocklist**: Blocks `script`, `iframe`, `object`, `embed`, and other dangerous tags.
4. **Module allowlist**: Only pre-approved modules may be imported.
5. **Manifest integrity**: In strict mode, all imports must have exact URL mappings.
6. **Execution budgets**: Wall-clock timeouts, import count limits, and component invocation limits, enforced via `Promise.race()`.
7. **Sandbox isolation**: Three sandbox modes — Worker/iframe/ShadowRealm — with automatic fallback chains.

The overall strategy is **fail-closed by default**: tags, modules, hosts, and execution profiles not explicitly permitted by the policy are rejected. In strict/balanced mode, uncovered bare specifiers are also rejected. The `relaxed` profile selectively loosens these constraints.

## Browser ESM Module Graph Materialization

A key engineering capability of Renderify is how it resolves and loads npm packages entirely in the browser — without any server-side bundler.

### Background

Browsers natively support ES Modules, but with one critical limitation: **bare specifiers are not supported**. You cannot directly `import { format } from "date-fns"` in the browser. Traditional solutions require bundlers like webpack or Vite to resolve these specifiers on the server, which contradicts Renderify's zero-build-step design goal.

### Solution: The fetch → rewrite → blob URL Pipeline

```
Source code
  → es-module-lexer extracts import declarations
    → JSPM CDN resolves bare specifiers
      → Recursively materialize child dependency imports
        → Rewrite import statements to resolved URLs
          → Create blob: URL
            → dynamic import() to load
```

The detailed flow:

1. **Lexical extraction**: Use `es-module-lexer` to extract all import declarations from the source code.
2. **Specifier resolution**: Resolve bare specifiers (e.g., `recharts`) to exact CDN URLs via the JSPM CDN.
3. **Recursive materialization**: Fetch remote module source, parse its child imports, and recursively repeat the same process.
4. **Rewriting**: Replace all import specifiers with materialized blob/data URLs.
5. **Packaging**: Create a blob URL from the rewritten source.
6. **Loading**: Load the blob URL via `dynamic import()`.

### Asset Proxy Modules

For non-JavaScript assets, Renderify handles them transparently through proxy modules:

- **CSS imports**: Converted to `<style>` injection proxy modules (deduplicated by FNV-1a hash — created on first encounter, reused on subsequent ones).
- **JSON imports**: Wrapped as `export default <parsed-json>` ESM modules.
- **Binary assets**: Converted to proxy modules that export the CDN URL.

### Auto-Pin-Latest Strategy

`renderPlanInBrowser` enables auto-pin-latest mode by default:

1. Developers use bare imports in source code (e.g., `import { format } from "date-fns/format"`).
2. On first run, Renderify resolves the bare specifier to an exact versioned URL via JSPM.
3. The resolution result is immediately injected into the `moduleManifest`; subsequent executions use the pinned version.

For production, use `manifest-only` mode (`autoPinLatestModuleManifest: false`) to ensure fully pre-pinned, auditable dependency mappings.

## React Ecosystem Compatibility Bridge

LLM-generated code typically uses the React API — it is the most common frontend framework in model training data.

Renderify transparently redirects common React imports to the Preact compat layer via built-in compatibility mappings (Preact is approximately 3–4KB gzipped, significantly smaller than the React runtime; exact figures vary by version), reducing runtime overhead and improving cold-start performance:

```typescript
const DEFAULT_JSPM_SPECIFIER_OVERRIDES = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat",
  "react/jsx-runtime": "preact/jsx-runtime",
  recharts: "recharts@3.3.0",
  // ...
};
```

This means LLMs can freely generate standard React code, and it will execute on the smaller, faster Preact runtime. React ecosystem libraries such as Recharts and MUI work as expected.

## Streaming Rendering Architecture

In Chat UI scenarios, users expect real-time feedback. Renderify's streaming pipeline delivers progressive preview updates while the LLM is still generating code:

```
LLM tokens ──▶ llm-delta chunks ──▶ preview renders ──▶ final render
```

1. **llm-delta**: Each token from the LLM is emitted as a chunk.
2. **preview**: At configurable intervals, the accumulated text is parsed and rendered as a preview.
3. **final**: After LLM completion, the full pipeline executes and emits the final result.
4. **error**: If any stage fails, an error chunk is emitted before the exception propagates.

### Efficient Change Detection

The streaming code generation stage uses FNV-1a 64-bit hashing for efficient change detection. As the LLM continuously outputs tokens, the system computes a hash signature over the accumulated text — only re-parsing and re-rendering when the signature changes. This avoids redundant computation during streaming while maintaining responsive incremental previews.

## Plugin System

The `CustomizationEngine` provides 10 hook points covering every pipeline stage:

```
beforeLLM → [LLM] → afterLLM
  → beforeCodeGen → [CodeGen] → afterCodeGen
    → beforePolicyCheck → [Security] → afterPolicyCheck
      → beforeRuntime → [Runtime] → afterRuntime
        → beforeRender → [UI] → afterRender
```

Each hook receives the current stage's payload and can transform it before passing it to the next stage. Multiple plugins execute in registration order. This design lets developers inject custom logic without forking the core — from modifying the LLM prompt to post-processing render output.

## Sandbox Execution Model

For scenarios requiring stronger isolation, Renderify offers three browser sandbox modes:

| Mode                  | Mechanism                                         | Characteristics                                          |
| --------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `sandbox-worker`      | Web Worker + blob URL + `postMessage`             | Separate-thread execution with timeout and abort support |
| `sandbox-iframe`      | `sandbox="allow-scripts"` iframe + MessageChannel | Isolated document context                                |
| `sandbox-shadowrealm` | ShadowRealm API + blob URL bridge                 | Same-thread isolated realm                               |

The three modes support automatic fallback chains — if the preferred mode is unavailable, execution automatically falls back to the next one. Each mode supports configurable timeouts and fail-closed behavior (fail-closed by default; can be disabled via `browserSourceSandboxFailClosed` to fall back to non-sandboxed execution on failure).

## DOM Reconciliation and UI Rendering

`DefaultUIRenderer` is not a simple `innerHTML` replacement — it implements a full DOM reconciliation algorithm:

1. **Keyed + positional child matching**: Prioritizes key-based matching, then falls back to positional matching.
2. **Differential attribute updates**: Only updates attributes that have actually changed.
3. **Text node updates**: Directly modifies `textContent` rather than replacing the node.
4. **Interactive state preservation**: Preserves scroll positions during reconciliation and avoids overwriting `value`/`checked` on focused input elements.
5. **Event delegation**: Implements event handling via `data-renderify-event-*` attributes and `CustomEvent` dispatch.
6. **XSS protection**: Blocks dangerous tags/attributes and sanitizes inline styles (blocking `expression()`, `url()`, `javascript:`, etc.).

## One-Line Embed API

Renderify provides a minimal embed API — a single call completes the entire flow from Plan to rendered UI:

```typescript
import { renderPlanInBrowser } from "renderify";

await renderPlanInBrowser(plan, { target: "#mount" });
```

Internally, this call automatically creates all required infrastructure — module loader, security checker, runtime manager, UI renderer — and uses a `WeakMap`-backed render lock to ensure concurrent renders to the same DOM target are properly serialized.

A complete 30-second example:

```tsx
import { renderPlanInBrowser } from "renderify";

renderPlanInBrowser(
  {
    id: "hello_jsx_runtime",
    version: 1,
    root: { type: "text", value: "Loading..." },
    source: {
      language: "tsx",
      code: `
        import { format } from "date-fns/format";

        export default function App() {
          return <section>Today: {format(new Date(), "yyyy-MM-dd")}</section>;
        }
      `,
    },
  },
  { target: "#mount" },
);
```

The code above does three things: (1) executes JSX/TSX directly at browser runtime; (2) auto-resolves the `date-fns` bare import via JSPM; (3) pins the resolved URL into `moduleManifest` before execution.

## Performance Optimization Strategies

### Transpilation Cache

The runtime transpiler uses an LRU cache (256 entries) with cache keys composed from `language/runtime/filename/code`, avoiding redundant transpilation of unchanged source code.

### Request Deduplication

Both `JspmModuleLoader` and `RuntimeSourceModuleLoader` implement request deduplication — when multiple components request the same module concurrently, only a single network request is made.

### Multi-CDN Fault Tolerance

Module fetching supports multi-CDN fallback using `Promise.any` for hedged requests. The default source is the JSPM GA CDN, with fallback to esm.sh and other alternative CDNs on failure.

### Budget Racing

Execution budgets constrain async paths via remaining-time calculation + `Promise.race()`. For synchronously blocking code, sandboxed execution (such as browser sandbox or `isolated-vm`) is still required to mitigate the risk of main-thread stalls.

### Blob URL Cleanup

The runtime manager tracks all created blob URLs and revokes them in bulk during cleanup to prevent memory leaks.

### Tuning Parameters

| Parameter                     | Default                                      | Impact                                    |
| ----------------------------- | -------------------------------------------- | ----------------------------------------- |
| `enableDependencyPreflight`   | `true`                                       | Better safety and earlier failure signals |
| `remoteFetchTimeoutMs`        | `12000`                                      | Prevents long hangs                       |
| `remoteFetchRetries`          | `2`                                          | Better resilience                         |
| `browserSourceSandboxMode`    | `worker` in browser (`none` outside browser) | Isolation for untrusted source code       |
| `autoPinLatestModuleManifest` | `true`                                       | Developer experience for bare imports     |

## Use Cases

Renderify is well-suited for the following scenarios:

- **LLM Chat / Agent platforms**: Render dynamic UI from model output — dashboards, forms, cards, data visualizations.
- **AI Agent toolchains**: An Agent analyzes user data and dynamically generates interactive dashboards or operation interfaces, rather than just returning text.
- **Low-Code / No-Code AI backends**: Users describe intent in natural language; the LLM generates a runnable UI component on the fly.
- **Dynamic forms and approval workflows**: Generate context-aware forms at runtime, more flexible than JSON Schema renderers.
- **Rapid prototyping**: Go from prompt to rendered UI in seconds, not minutes.
- **Safe rendering of untrusted UI**: Any application that needs to securely render dynamically generated UI in the browser.

## Getting Started

### SDK Embedding (Recommended)

```bash
pnpm add renderify
```

```typescript
import { renderPlanInBrowser } from "renderify";

await renderPlanInBrowser(
  {
    id: "quickstart",
    version: 1,
    root: { type: "text", value: "Loading..." },
    source: {
      language: "tsx",
      code: `export default () => <section>Hello from Renderify</section>;`,
    },
  },
  { target: "#mount" },
);
```

### CLI Playground

```bash
# Start the browser Playground
pnpm playground

# Render from a prompt
pnpm cli -- run "Build a welcome card"

# Output RuntimePlan JSON
pnpm cli -- plan "Build a welcome card"

# Probe plan compatibility (security policy + runtime preflight)
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json

# Configure LLM provider
RENDERIFY_LLM_PROVIDER=openai RENDERIFY_LLM_API_KEY=<key> pnpm playground
RENDERIFY_LLM_PROVIDER=anthropic RENDERIFY_LLM_API_KEY=<key> pnpm playground
RENDERIFY_LLM_PROVIDER=google RENDERIFY_LLM_API_KEY=<key> pnpm playground
```

### Renderer-Only Mode (No LLM)

From a capability standpoint, Renderify's LLM integration is optional. You can supply a RuntimePlan from any source — your backend API, another SDK, or a different model provider.

Note that the top-level `renderify` package includes `@renderify/llm` as a dependency for out-of-the-box convenience. If you want to minimize the runtime entry point, use `@renderify/runtime` + `@renderify/ir` directly:

```typescript
import { renderPlanInBrowser } from "@renderify/runtime";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only",
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

## Design Philosophy and Technical Highlights

### 1. IR as a Stable Contract

The RuntimePlan intermediate representation fully decouples LLM output format from execution and rendering. Even outside of Renderify, this IR design provides a reusable schema for any system that needs to describe "LLM-generated interactive UI."

### 2. Reusable Security Policy Framework

A systematic approach to executing untrusted dynamic code — tag blocklists, module allowlists, execution budgets, source pattern analysis — this policy model can be extracted and applied to any browser-side dynamic code execution scenario.

### 3. Browser ESM Module Graph Materialization

The `fetch → rewrite imports → blob URL` pipeline solves a problem that browser standards have not yet natively addressed — bare specifiers are not usable in browsers. This module loading strategy can be extracted as a standalone utility.

### 4. Strategy over Convention

Key components throughout the system employ the Strategy pattern — transpilers (Babel/esbuild), sandbox modes (Worker/iframe/ShadowRealm), LLM providers (five built-in implementations), module loaders — all are swappable implementations behind interfaces.

### 5. Zero-Configuration React Compatibility

LLMs generate standard React code that transparently executes on the Preact compat runtime — no additional configuration or special handling required.

## Conclusion

Renderify represents an important infrastructure layer in LLM application development — it solves the last-mile problem between "an LLM can generate code" and "users can see and interact with that UI." Its value stems from a set of composable engineering capabilities:

- **Zero-build runtime rendering**: Fully browser-side transpilation and module resolution via Babel Standalone + JSPM CDN.
- **Defense-in-depth security**: Seven independent defense layers ensuring LLM-generated untrusted code is executed safely.
- **Browser ESM module graph materialization**: The fetch → rewrite → blob URL pipeline, constructing module dependency graphs in the browser.
- **Streaming rendering**: Efficient change detection based on FNV-1a hashing, delivering real-time incremental UI previews.
- **Minimal API**: A single line of code from RuntimePlan to fully rendered interactive UI.

Renderify provides a solid technical foundation for building the next generation of AI-driven dynamic UI applications. Whether it's rich interactive components in chat interfaces, AI Agent-generated data dashboards, or natural-language-driven low-code platforms, Renderify turns LLM UI generation capabilities into tangible, interactive product experiences.

A note on comparisons: cross-product size and performance claims should be substantiated with benchmarks under fixed versions, fixed scenarios, and fixed network conditions before drawing conclusions.
