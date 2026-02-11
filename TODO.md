# TODO

## Baseline Reliability
- [x] normalize package structure and workspace graph
- [x] make `validate`, `typecheck`, `build` pass
- [x] add unit tests for `ir/codegen/security/runtime/core`
- [x] add CI workflow

## Runtime Capability
- [x] establish runtime pipeline (`llm -> codegen -> policy -> runtime -> ui`)
- [x] keep JSPM as default module loader (`@renderify/runtime-jspm`)
- [x] add stateful IR actions/events/transitions
- [x] add runtime quotas (`maxImports/maxExecutionMs/maxComponentInvocations`)
- [x] add rollback and plan version registry

## Security and Observability
- [x] implement policy-based plan checks
- [x] validate state transitions and quota requests in security checker
- [x] add security policy profiles (`strict/balanced/relaxed`)
- [x] add tenant quota governor and throttled audits
- [x] add execution audit log format
- [x] add trace replay tool

## Developer Experience
- [x] provide CLI prompt/plan/html smoke path
- [x] provide browser playground for live runtime inspection
- [x] publish plugin/loader integration guide
- [x] add sandbox execution profile baseline (`isolated-vm`)
