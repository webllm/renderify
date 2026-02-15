# Performance Tuning Guide

This guide focuses on concrete runtime knobs and operational practices to reduce latency and prevent regressions.

## 1. Establish a Baseline

Run the benchmark suite first:

```bash
pnpm bench
```

For CI artifact output:

```bash
pnpm bench:ci
# writes .artifacts/benchmarks/runtime-bench.json
```

Useful environment variables for benchmark sensitivity:

```bash
RENDERIFY_BENCH_TIME_MS=400
RENDERIFY_BENCH_WARMUP_MS=200
```

## 2. Measure the Real Pipeline

If you use `@renderify/core`, provide your own `DefaultPerformanceOptimizer` and read metrics from it:

```ts
import {
  createRenderifyApp,
  DefaultPerformanceOptimizer,
} from "@renderify/core";

const perf = new DefaultPerformanceOptimizer();
const app = createRenderifyApp({
  // ...other dependencies
  performance: perf,
});

app.on("rendered", (payload) => {
  console.log("render duration(ms):", payload?.metric?.durationMs);
});

console.table(perf.getMetrics());
```

If you use renderer-only integration, inspect these outputs on every render:

- `security.issues`
- `execution.diagnostics`
- preflight result (`runtime.probePlan(plan)`)

## 3. Tune the Highest-Impact Knobs

| Knob | Default | Impact | Tradeoff |
| --- | --- | --- | --- |
| `enableDependencyPreflight` | `true` | Better safety and earlier failure signals | Adds startup latency |
| `failOnDependencyPreflightError` | `false` | Fast fail for strict CI/prod lanes | Lower tolerance for flaky CDNs |
| `remoteFetchTimeoutMs` | `12000` | Prevents long hangs | Too low can create false timeouts |
| `remoteFetchRetries` | `2` | Better resilience | More retries increase tail latency |
| `remoteFallbackCdnBases` | `['https://esm.sh']` | Better availability | Must align with security host policy |
| `browserSourceSandboxMode` | browser:`worker`, server:`none` | Isolation for untrusted source | Worker/iframe adds overhead |
| `browserSourceSandboxTimeoutMs` | `4000` | Bounds worst-case source execution | Too low may cut valid workloads |
| `runtimeSourceJsxHelperMode` | `auto` | Predictable transpilation behavior | `always` can add minor output overhead |
| `autoPinLatestModuleManifest` | `true` | Great DX for bare imports | Latest-based resolution can drift |

## 4. Scenario Presets

### Low-Latency Interactive Preview

Use in chat preview paths where responsiveness matters more than strict fail-fast.

```ts
const runtime = new DefaultRuntimeManager({
  enableDependencyPreflight: false,
  remoteFetchTimeoutMs: 6000,
  remoteFetchRetries: 1,
  browserSourceSandboxMode: "worker",
  browserSourceSandboxTimeoutMs: 2500,
});
```

### Deterministic Production Rendering

Use when reproducibility and policy guarantees are required.

```ts
const runtime = new DefaultRuntimeManager({
  enforceModuleManifest: true,
  enableDependencyPreflight: true,
  failOnDependencyPreflightError: true,
  allowIsolationFallback: false,
  browserSourceSandboxMode: "worker",
  browserSourceSandboxFailClosed: true,
  remoteFallbackCdnBases: [],
});
```

### High-Volume Concurrency

- Reuse initialized runtime instances instead of creating a new runtime per request.
- Keep `serializeTargetRenders` enabled for same-target UI safety.
- Bound render cancellations with `AbortController` to shed load quickly.

## 5. Memory and Lifecycle Hygiene

The runtime keeps in-memory module URL caches for browser source execution. For long-lived pages:

- Reuse a runtime instance for steady traffic.
- Periodically recycle runtime instances in very long sessions.
- Always call `runtime.terminate()` on shutdown/unmount to clear caches and revoke blob URLs.

Example:

```ts
await runtime.initialize();

try {
  await runtime.execute({ plan });
} finally {
  await runtime.terminate();
}
```

## 6. Protect Against Regressions

Use these checks in CI:

1. `pnpm typecheck`
2. `pnpm unit`
3. `pnpm compat`
4. `pnpm bench:ci` and compare key metrics (`meanMs`, `rme`, `samples`)

Suggested policy:

- Block merge if `meanMs` regresses more than an agreed threshold (for example 10%).
- Track trend over multiple runs instead of a single datapoint to reduce noise.

## 7. Quick Debug Checklist for Slow Renders

1. Run `probe-plan` to isolate dependency failures from execution logic.
2. Inspect `execution.diagnostics` for timeout and import budget messages.
3. Check module count and transitive dependency size in `plan.source` imports.
4. Reduce fallback retries if tail latency dominates.
5. Switch sandbox mode only after confirming it is the dominant overhead.

## Related Docs

- [`docs/runtime-execution.md`](./runtime-execution.md)
- [`docs/security.md`](./security.md)
- [`docs/troubleshooting-faq.md`](./troubleshooting-faq.md)
- [`docs/cookbook.md`](./cookbook.md)
