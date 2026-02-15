# @renderify/security

Security policy engine for Renderify RuntimePlan execution.

`@renderify/security` validates plans, capabilities, module sources, and runtime source code before execution.

## Install

```bash
pnpm add @renderify/security @renderify/ir
# or
npm i @renderify/security @renderify/ir
```

## Main API

- `DefaultSecurityChecker`
- `listSecurityProfiles()`
- `getSecurityProfilePolicy(profile)`
- Types: `RuntimeSecurityPolicy`, `SecurityCheckResult`, `RuntimeSecurityProfile`

## Profiles

- `strict`
- `balanced` (default)
- `relaxed`

## Quick Start

```ts
import { DefaultSecurityChecker } from "@renderify/security";

const checker = new DefaultSecurityChecker();
checker.initialize({ profile: "strict" });

const result = await checker.checkPlan(plan);
if (!result.safe) {
  console.error(result.issues);
}
```

## What It Checks

- Blocked HTML tags and tree limits
- Allowed module specifiers and network hosts
- Execution profile limits and capability quotas
- Runtime source module constraints
- Spec version and module manifest requirements

## Notes

- `checkPlan()` is async.
- Use policy overrides via `initialize({ profile, overrides })` for environment-specific constraints.
