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
  - `executionProfile` support (`standard` / `isolated-vm`)
  - default fail-closed behavior when isolated runtime is unavailable
- Developer experience:
  - CLI commands: `run`, `plan`, `probe-plan`, `render-plan`, `playground`
  - browser runtime playground with prompt/plan/stream/probe APIs
  - plugin/loader integration guide
- Quality:
  - unit tests for `ir/codegen/security/runtime/core`
  - E2E tests for CLI + playground API
  - OpenAI adapter tests (structured/text paths)
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

- Production-grade sandbox isolation hardening (worker/vm boundary progression)
- Additional LLM providers and production resiliency (retry/backoff/circuit breaker)
- Runtime/component performance profiling and optimization under large plans
