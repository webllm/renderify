# @renderify/ir

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
