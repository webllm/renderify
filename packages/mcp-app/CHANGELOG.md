# @renderify/mcp-app

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

Release notes are generated from Changesets. The pending initial release is
described by the repository changeset for this package.
