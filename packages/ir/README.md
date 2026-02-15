# @renderify/ir

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/ir.svg)
![license](https://img.shields.io/npm/l/@renderify/ir)

Runtime IR contracts and utilities for Renderify.

`@renderify/ir` defines the RuntimePlan schema, node/state/action types, guards, path helpers, import parsing, and shared constants used across all other packages.

## Install

```bash
pnpm add @renderify/ir
# or
npm i @renderify/ir
```

## Main Exports

- Types: `RuntimePlan`, `RuntimeNode`, `RuntimeCapabilities`, `RuntimeExecutionResult`, `RuntimeSourceModule`
- Guards: `isRuntimePlan`, `isRuntimeNode`, `isJsonValue`
- Builders: `createTextNode`, `createElementNode`, `createComponentNode`
- Path utils: `getValueByPath`, `setValueByPath`, `isSafePath`
- Import parsing: `collectRuntimeSourceImports`, `parseRuntimeSourceImportRanges`
- Hash utils: `hashStringFNV1a32`, `createFnv1a64Hasher`
- Shared constants: `DEFAULT_RUNTIME_PLAN_SPEC_VERSION`, `DEFAULT_JSPM_SPECIFIER_OVERRIDES`

## Quick Start

```ts
import {
  createElementNode,
  createTextNode,
  isRuntimePlan,
  type RuntimePlan,
} from "@renderify/ir";

const plan: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "demo",
  version: 1,
  capabilities: { domWrite: true },
  root: createElementNode("div", {}, [createTextNode("Hello Renderify")]),
};

if (!isRuntimePlan(plan)) {
  throw new Error("Invalid RuntimePlan");
}
```

## Notes

- This package is framework-agnostic.
- All other Renderify packages depend on these contracts.
