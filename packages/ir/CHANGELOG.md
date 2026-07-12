# @renderify/ir

## 0.8.0

### Minor Changes

- 7fce967: Add `isRuntimeNodeShallow` and upgrade `isRuntimeNode` to validate complete RuntimeNode trees, including descendants, props, and component exports, without recursion limits or accessor execution.

### Patch Changes

- 7fce967: Make RuntimeNode validation and traversal reject cycles and safely handle very deep trees iteratively.
- 28669be: Harden JSON guards and normalization for cyclic values, sparse/accessor-backed arrays, getters, and exotic objects without invoking user code.
- 793c7d7: Reject prototype-polluting paths in state getters/setters and read only own properties during path traversal.
- 7d9e4ae, c12f809: Publish unambiguous `.mjs` and `.cjs` entry points and make package cleanup work cross-platform.

## 0.7.0

### Minor Changes

- fix

## 0.6.1

### Patch Changes

- Republish with no package-level source changes to align with the `v0.6.1` workspace release.

## 0.6.0

### Minor Changes

- fix renderify

## 0.5.0

### Minor Changes

- fix renderify

## 0.4.0

### Minor Changes

- fix renderify

## 0.3.0

### Minor Changes

- fix render and update docs

## 0.2.0

### Minor Changes

- fix renderer

## 0.1.0

### Minor Changes

- implement core
