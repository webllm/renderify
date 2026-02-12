# Implementation Status

## Delivered Scope

- Runtime pipeline:
  - prompt -> codegen -> policy -> runtime -> UI render
  - structured LLM output preferred with text fallback
  - streaming prompt path (`renderPromptStream`) with preview chunks
- Runtime execution:
  - runtime source execution (`plan.source`) for `js/jsx/ts/tsx`
  - source import rewrite through JSPM loader resolver
  - `source.runtime: "preact"` path for React-compatible component rendering
  - package support contract enforcement in JSPM loader (builtin/scheme fail-fast)
  - runtime dependency preflight and diagnostics
- Runtime safety:
  - blocked tags / depth / node count checks
  - module and host allowlist checks
  - runtime plan `specVersion` compatibility checks
  - module manifest coverage/integrity checks for bare imports
  - runtime source static pattern checks
  - profile presets: `strict/balanced/relaxed`
- Runtime limits:
  - import count limit
  - execution time budget limit
  - component invocation limit
  - end-to-end `AbortSignal` cancellation propagation across core/llm/runtime
  - `executionProfile` support (`standard` / `isolated-vm` / `sandbox-worker` / `sandbox-iframe`)
  - browser runtime source sandbox (worker/iframe) with fail-closed option
  - worker/iframe sandbox execution now abortable (terminate-on-cancel)
  - default fail-closed behavior when isolated runtime is unavailable
- Developer experience:
  - CLI commands: `run`, `plan`, `probe-plan`, `render-plan`, `playground`
  - browser runtime playground with prompt/plan/stream/probe APIs
  - plugin/loader integration guide
  - package support contract document: `docs/architecture/package-support-contract.md`
- Quality:
  - unit tests for `ir/codegen/security/runtime/core`
  - E2E tests for CLI + playground API
  - OpenAI/Anthropic/Google adapter tests (structured/text paths)
  - source module runtime tests (execution and import rewrite)

## Verified Commands

- `pnpm typecheck`
- `pnpm unit`
- `pnpm e2e`
- `pnpm test`
- `pnpm validate`
- `pnpm build`
- `pnpm cli run "..."`
- `pnpm cli probe-plan <file>`
- `pnpm playground`

## Remaining High-Value Items

- Production-grade sandbox isolation hardening (worker/iframe + CSP + stricter capability gates)
- Local-model providers and production resiliency (retry/backoff/circuit breaker)
- Runtime/component performance profiling and optimization under large plans
