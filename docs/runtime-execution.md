# Runtime Execution

The runtime execution engine is the core of Renderify. It takes a validated RuntimePlan, resolves modules, transpiles source code, executes the plan, and produces a rendered result.

## Execution Pipeline

```
RuntimePlan
  │
  ├── Validate spec version
  ├── Initialize state (if plan.state exists)
  ├── Resolve imports (module manifest → JSPM CDN)
  ├── Execute source module (if plan.source exists)
  │     ├── Transpile (Babel: TSX/JSX → JS)
  │     ├── Rewrite bare imports → CDN URLs
  │     ├── Create blob: URL
  │     ├── Dynamic import()
  │     └── Extract default export
  ├── Resolve node tree (element/text/component nodes)
  ├── Track execution budget
  └── Return RuntimeExecutionResult
```

## DefaultRuntimeManager

The main execution engine is configured via `RuntimeManagerOptions`:

```ts
import { DefaultRuntimeManager, JspmModuleLoader } from "@renderify/runtime";

const runtime = new DefaultRuntimeManager({
  // Module loading
  moduleLoader: new JspmModuleLoader({ cdnBaseUrl: "https://ga.jspm.io" }),

  // Module manifest enforcement
  enforceModuleManifest: true,

  // Isolation fallback behavior
  allowIsolationFallback: false,

  // Supported spec versions
  supportedPlanSpecVersions: ["runtime-plan/v1"],

  // Dependency preflight
  enableDependencyPreflight: true,
  failOnDependencyPreflightError: false,

  // Remote fetch configuration
  remoteFetchTimeoutMs: 12000,
  remoteFetchRetries: 2,
  remoteFetchBackoffMs: 150,
  remoteFallbackCdnBases: ["https://esm.sh", "https://cdn.jsdelivr.net"],

  // Browser sandbox
  browserSourceSandboxMode: "worker",  // "none" | "worker" | "iframe"
  browserSourceSandboxTimeoutMs: 4000,
  browserSourceSandboxFailClosed: true,
});

await runtime.initialize();
```

## Module Loading

### JSPM Module Loader

The `JspmModuleLoader` resolves bare npm specifiers to browser-loadable ESM URLs:

```ts
import { JspmModuleLoader } from "@renderify/runtime";

const loader = new JspmModuleLoader({
  cdnBaseUrl: "https://ga.jspm.io",  // Default JSPM CDN
});

// Resolve a specifier
const url = loader.resolveSpecifier("lodash-es");
// => "https://ga.jspm.io/npm:lodash-es"
```

### Resolution Strategy

1. **Module manifest** — if the plan's `moduleManifest` has an entry, use `resolvedUrl`
2. **Built-in overrides** — compatibility aliases (React → Preact, recharts)
3. **Custom import maps** — user-provided mappings
4. **JSPM CDN** — bare specifiers resolved to `https://ga.jspm.io/npm:{package}`
5. **Fallback CDNs** — on failure, tries configured fallback bases (default: esm.sh)

### Rejected Specifiers

The loader rejects:
- Node.js builtins (`fs`, `path`, `crypto`, `os`, etc.)
- `file://` URLs
- `jsr:` specifiers
- Empty or whitespace-only specifiers

### React Compatibility Bridge

React ecosystem packages work transparently because all React imports are mapped to Preact:

```
react              → preact/compat
react-dom          → preact/compat
react-dom/client   → preact/compat
react/jsx-runtime  → preact/jsx-runtime
```

This means `recharts`, `@mui/material`, and other React-first packages work out of the box.

### Asset Module Proxying

Non-JS modules are converted to executable proxies:

- **CSS imports** — fetched and injected as `<style>` elements via a proxy module
- **JSON imports** — fetched and re-exported as ESM default exports

## Source Module Execution

When a plan includes `plan.source`, the runtime executes a full source pipeline:

### Transpilation

The `BabelRuntimeSourceTranspiler` uses `@babel/standalone` (loaded on demand):

```ts
// Input: TSX source
import { useState } from "preact/hooks";
export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c+1)}>Count: {count}</button>;
}

// Output: Transpiled JS with import rewriting
import { useState } from "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
export default function App() {
  const [count, setCount] = useState(0);
  return h("button", { onClick: () => setCount(c => c+1) }, "Count: ", count);
}
```

### JSX Runtime Modes

Two modes are supported:

- **`runtime: "preact"`** — uses Preact's automatic JSX transform (`jsxRuntime`)
- **`runtime: "renderify"`** — uses custom `__renderify_runtime_h()` that produces RuntimeNode objects

### Import Rewriting

After transpilation, `es-module-lexer` extracts all import specifiers. Each bare specifier is resolved to a full CDN URL, and the source is rewritten with the resolved URLs. The final source is loaded via a `blob:` URL with `dynamic import()`.

### Module Graph Materialization

For complex source modules with transitive dependencies, the runtime materializes the full module graph:

```
Source code
  ├── import "preact" → fetch from JSPM → rewrite nested imports → blob URL
  ├── import "recharts" → fetch from JSPM → rewrite nested imports → blob URL
  └── import "lodash-es" → fetch from JSPM → rewrite nested imports → blob URL
```

Each module is fetched, its imports are recursively rewritten, and it's stored as a blob URL. This solves the browser limitation where bare specifiers are not supported in native ESM.

## Execution Profiles

### Standard (default)

Source executes in the main page context. No isolation.

### isolated-vm

Synchronous component execution in a VM-isolated context. The component function must be synchronous — async components are rejected. Uses fail-closed behavior when the isolation runtime is unavailable.

### sandbox-worker

Source code executes in a Web Worker. The worker has a configurable timeout and communicates results via `postMessage`. If execution exceeds the timeout, the worker is terminated.

```bash
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=worker
RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true
```

### sandbox-iframe

Source code executes in a sandboxed iframe with restricted permissions. Similar timeout and fail-closed behavior as worker mode.

## Execution Budgets

The runtime tracks three budget dimensions during execution:

| Budget | What It Tracks | What Happens When Exceeded |
|--------|---------------|---------------------------|
| Import budget | Number of module imports resolved | Execution stops, diagnostic emitted |
| Component budget | Number of component node renders | Execution stops, diagnostic emitted |
| Time budget | Wall-clock execution time | Execution stops, diagnostic emitted |

Budgets are configured via `plan.capabilities`:

```json
{
  "capabilities": {
    "maxImports": 50,
    "maxComponentInvocations": 200,
    "maxExecutionMs": 10000
  }
}
```

## Dependency Preflight

Before execution, the runtime can probe all required modules to verify availability:

```ts
const probeResult = await runtime.probePlan(plan);

// probeResult.dependencies: RuntimeDependencyProbeStatus[]
// probeResult.diagnostics: RuntimeDiagnostic[]
```

Preflight checks:
- `plan.imports` specifiers
- Component node modules
- Source code imports

Configuration:

```bash
# Enable preflight (default: true)
RENDERIFY_RUNTIME_PREFLIGHT=true

# Fail-fast on first preflight error
RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST=true
```

## Remote Fetch Configuration

Module fetching supports retry, timeout, and CDN fallback:

```bash
# Fetch timeout per module
RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS=12000

# Number of retries per module
RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES=2

# Fallback CDN base URLs (comma-separated)
RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS=https://esm.sh,https://cdn.jsdelivr.net
```

The runtime issues hedged fetch attempts across the primary URL and configured fallback CDNs. The first successful response wins.

## State Management

The runtime maintains per-plan state snapshots:

```ts
// Get current state
const state = runtime.getPlanState("plan-id");

// Override state
runtime.setPlanState("plan-id", { count: 42 });

// Clear state
runtime.clearPlanState("plan-id");
```

State is initialized from `plan.state.initial` on first execution. Subsequent executions preserve state across renders.

### Declarative Transitions

State transitions are defined in `plan.state.transitions` and triggered by runtime events:

```json
{
  "state": {
    "initial": { "count": 0, "active": false },
    "transitions": {
      "increment": [{ "type": "increment", "path": "count" }],
      "toggle": [{ "type": "toggle", "path": "active" }],
      "reset": [{ "type": "set", "path": "count", "value": 0 }]
    }
  }
}
```

## Template Interpolation

Text nodes support template interpolation with double-brace syntax:

```
"Count: {{state.count}}"        → "Count: 42"
"Hello, {{context.userId}}"     → "Hello, user_123"
"Theme: {{vars.theme}}"         → "Theme: dark"
```

Interpolation resolves against the current execution context, including state, context variables, and event payloads.

## Render Artifacts

When a source module produces a Preact component, the runtime emits a `renderArtifact`:

```ts
interface RuntimeRenderArtifact {
  mode: "preact-vnode";
  payload: unknown;  // Preact VNode
}
```

The UI renderer uses this artifact for Preact-native rendering with full reconciliation support, rather than falling back to HTML string conversion.

## Abort Support

All runtime operations accept an `AbortSignal`:

```ts
const controller = new AbortController();

const result = await runtime.execute({
  plan,
  context: { userId: "user_1" },
  signal: controller.signal,
});
```

When aborted:
- In-progress module fetches are cancelled
- Worker sandbox execution is terminated
- An `AbortError` is thrown

## Environment Variables Reference

```bash
# Module manifest enforcement
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true

# Isolation fallback
RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK=false

# Supported spec versions
RENDERIFY_RUNTIME_SPEC_VERSIONS=runtime-plan/v1

# Dependency preflight
RENDERIFY_RUNTIME_PREFLIGHT=true
RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST=true

# Remote fetch
RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS=12000
RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES=2
RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS=https://esm.sh,https://cdn.jsdelivr.net

# Browser sandbox
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=worker
RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true
```
