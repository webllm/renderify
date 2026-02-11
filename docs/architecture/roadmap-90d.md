# 90-Day Roadmap

## Phase 1 (Day 0-30): Runtime Baseline Hardening

Status: completed

Delivered:

1. contract tests for `@renderify/ir`
2. policy tests for blocked tags/modules/hosts
3. runtime execution tests for success/failure branches
4. CI pipeline for `typecheck + validate + test + build`

## Phase 2 (Day 31-60): Dynamic Capability Expansion

Status: completed

Delivered:

1. IR extensions for state/event/action contracts
2. stateful execution context and transition application
3. runtime quotas and diagnostics for limit exceed cases
4. replay-compatible audit records including event context

## Phase 3 (Day 61-90): Production Guardrails

Status: mostly completed

Delivered:

1. immutable plan versioning and rollback API
2. execution audit log schema and replay workflow
3. browser playground for live runtime inspection

Remaining:

1. hardened isolation profile progression (worker/vm hardening)
2. multi-tenant policy profiles and governance controls

## Exit Criteria

1. live runtime updates without rebuild for validated plans
2. deterministic rejection for unsafe plans
3. reproducible execution traces with rollback/replay
4. reference runtime scenario executable from CLI + browser playground
