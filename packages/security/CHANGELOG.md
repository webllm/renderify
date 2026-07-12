# @renderify/security

## 0.8.0

### Minor Changes

- 2b1babd: Add `isRuntimeUrlAttribute`, `inspectRuntimeUrlAttribute`, and `RuntimeUrlAttributeInspection` for shared validation of HTML, SVG, list, source-set, and functional-IRI URL attributes.

### Patch Changes

- 42cfc5f: Disable runtime source modules in the strict and balanced profiles so source execution requires the explicitly trusted or relaxed lanes.
- bb30b18: Extend strict integrity coverage to every executable module reference, including direct HTTP(S) URLs, and reject missing/mismatched manifest targets or unsupported SRI formats.
- 2b1babd: Apply the plan network allowlist to declarative UI URLs and reject dangerous, obfuscated, or malformed URL protocols before runtime rendering.
- 87a2346: Cap module-manifest entry counts with the policy import limit so unused aliases cannot bypass resource budgets.
- 045e556: Reject invalid custom source-ban regular expressions atomically instead of silently weakening the active policy.
- d6550bb: Detach all policy array inputs and snapshots so caller mutation cannot modify initialized or built-in policies.
- 7d9e4ae, c12f809: Publish unambiguous `.mjs` and `.cjs` entry points and make package cleanup work cross-platform.
- Updated dependencies:
  - @renderify/ir@0.8.0

## 0.7.0

### Minor Changes

- fix

### Patch Changes

- Updated dependencies
  - @renderify/ir@0.7.0

## 0.6.1

### Patch Changes

- Add a `"trusted"` security profile for browser source execution, including runtime source modules and Preact with JSPM-only network defaults.
- Clarify `source.runtime="preact"` policy errors to direct callers to the `"trusted"` or `"relaxed"` profiles.

- Updated dependencies []:
  - @renderify/ir@0.6.1

## 0.6.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.6.0

## 0.5.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.5.0

## 0.4.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.4.0

## 0.3.0

### Minor Changes

- fix render and update docs

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.3.0

## 0.2.0

### Minor Changes

- fix renderer

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.2.0

## 0.1.0

### Minor Changes

- implement core

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.1.0
