# @renderify/mcp-app

## 0.10.0

### Patch Changes

- 9d8a287, 1be185b, d0c851a: Adopt the 0.10 declarative plan boundary for MCP
  Apps, rejecting misplaced node fields and JavaScript-style template
  expressions while preserving native JSON types for exact path templates.
- Updated dependencies:
  - @renderify/ir@0.10.0
  - @renderify/runtime@0.10.0
  - @renderify/security@0.10.0

## 0.9.0

### Minor Changes

- af75248, 924f4fa, 2be9f5e: Align MCP Apps with the hardened 0.9 declarative
  RuntimePlan pipeline, including bounded candidate normalization and correct
  React-style object attribute and CSS serialization.

### Patch Changes

- Updated dependencies:
  - @renderify/ir@0.9.0
  - @renderify/runtime@0.9.0
  - @renderify/security@0.9.0

## 0.8.0

### Minor Changes

- Align the MCP Apps adapter with the Renderify 0.8 release line.

### Patch Changes

- Publish concrete semver ranges for the internal IR, runtime, and security
  dependencies through pnpm's workspace-aware release path, and reject direct
  npm publishing before it can leak workspace protocols to registry consumers.
- Keep the npm-facing README focused on the public package contract and point
  repository readers to the maintained architecture and threat-model documents.
- Updated dependencies
  - @renderify/ir@0.8.1
  - @renderify/runtime@0.8.1
  - @renderify/security@0.8.1

## 0.1.1

### Patch Changes

- Republish the npm-facing README without repository-only document metadata.

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f343072]
  - @renderify/ir@0.8.1
  - @renderify/security@0.8.1
  - @renderify/runtime@0.8.1
