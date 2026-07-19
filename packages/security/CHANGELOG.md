# @renderify/security

## 0.10.0

### Patch Changes

- 7b55b86: Allow the trusted source profile to use `esm.sh` as a constrained
  package fallback without enabling arbitrary network access.
- Updated dependencies:
  - @renderify/ir@0.10.0

## 0.9.0

### Minor Changes

- e773efa, 924f4fa: Align security consumers with the hardened 0.9 RuntimePlan
  contract so malformed, cyclic, over-deep, and oversized candidates are rejected
  by the shared IR boundary before policy evaluation.

### Patch Changes

- Updated dependencies:
  - @renderify/ir@0.9.0

## 0.8.1

### Patch Changes

- f343072: Add an official MCP Apps adapter for self-contained, offline declarative
  RuntimePlans. Share declarative event parsing across IR, security, and runtime,
  classify relative URL references so the MCP boundary can reject navigation and
  resource paths, including control-character-obfuscated navigation protocols,
  restrict fragment-only hrefs to element types that cannot navigate or load the
  host page through an inherited `srcdoc` base URL,
  reject CSS `image-set()` string URLs in URL-bearing attributes and inline styles,
  reject runtime templates in URL-bearing attributes before interpolation,
  reject browser-managed SVG animation and timed mutation elements before they can
  change sanitized URL attributes, and lazy-load the source import lexer so strict
  browser CSP does not initialize WebAssembly for declarative-only plans. Treat
  cancellation and teardown as terminal so delayed tool responses cannot
  reactivate a view.
  Reject case-variant inline event attributes before HTML serialization.
  Ignore inherited object properties when resolving declarative transitions.
  Roll back the paired resource when MCP tool registration fails.
  Preserve explicitly empty tool-result summaries through app registration.
  Join concurrent controller disposal and always close the bridge after cleanup.
  Disconnect adapter-owned automatic resize observation at terminal lifecycle events.
  Close an established bridge when post-connect startup initialization fails.
  Forward the official SDK request context to registered handlers so they can use
  transport-provided authentication, cancellation, session, and request metadata.
  Treat app-called tool error results as failures without rendering their
  structured plan. Reuse the declarative renderer across replacement plans and
  keep identical replacement markup mounted while refreshing its session
  metadata. Detach delegated DOM listeners when the view ends. Normalize custom
  browser bundle line endings before hashing and reject explicitly empty or
  null-containing bundles. Include support for relative view entries by using the
  configured or current working directory as the bundler base. Include the
  repository MIT license in the published package.
- Updated dependencies [f343072]
  - @renderify/ir@0.8.1

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
