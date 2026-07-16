# @renderify/runtime

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
  - @renderify/security@0.8.1

## 0.8.0

### Minor Changes

- 42cfc5f, d933a3a: Add explicit `allowRuntimeSourceExecution` and `remoteModuleMaxBytes` runtime controls; source execution now defaults to disabled and remote module bodies have a configurable upper bound.
- d3eaf37, d98aca4: Extend `RuntimeModuleLoader` with abort signals, integrity-verified loading, and runtime network-policy configuration so custom loaders can enforce the same trust boundary.

### Patch Changes

- 42cfc5f, 521c451, 6f88032, 0f5a400: Fail closed when runtime source is not explicitly trusted or requested isolation is unavailable. Explicit browser sandbox profiles now require a terminable Worker, and reserved `isolated-vm` execution falls back to trusted standard execution only when `allowIsolationFallback` is enabled.
- d3eaf37, d98aca4: Execute the exact module bytes that passed integrity verification, never reuse unverified cache entries for pinned modules, and reapply network policy to redirects, fallbacks, retries, and transitive imports.
- 5024220, d933a3a, cad33fa: Enforce `maxImports` across complete transitive module graphs, roll back partial graph caches on budget failure, bound streamed module bodies, and reject circular remote dependency graphs without hanging.
- 4183bc9, 0f5a400: Preserve trusted browser Preact modules and same-origin companion imports for native loading while still charging cache hits and preserved imports to execution budgets and auditing their transitive network activity.
- 0f5a400: Propagate abort/deadline signals through remote response-body reads and in-flight module loading, and fail explicit browser sandbox profiles outside browser environments.
- 2b1babd: Apply security URL inspection to declarative UI attributes after context/state interpolation, dropping active protocols and remote request-capable URLs before serialization or DOM rendering.
- 7fce967: Resolve already-validated RuntimeNode trees shallowly at each step, avoiding repeated deep validation during rendering.
- c3cf872, 7d9e4ae, c12f809: Upgrade esbuild to 0.28.1, publish unambiguous `.mjs` and `.cjs` entry points, and make package cleanup work cross-platform.
- Updated dependencies:
  - @renderify/ir@0.8.0
  - @renderify/security@0.8.0

## 0.7.0

### Minor Changes

- fix

### Patch Changes

- e86c0ad: Clean up package sources to satisfy Biome lint rules.
- 17a4f62: Allow auto-pin-latest to hydrate relaxed-profile deep bare imports before the final module allowlist check.
- Updated dependencies
  - @renderify/ir@0.7.0
  - @renderify/security@0.7.0

## 0.6.1

### Patch Changes

- Add `renderTrustedPlanInBrowser` and `createTrustedInteractiveSession` with trusted browser defaults for source-module execution.
- Run security prechecks before auto-pin side effects and preserve caller-provided security state when preparing plans for execution.
- Tighten Preact source handling by rejecting plain-object output, validating class component returns, and preserving source identity across rerenders.

- Updated dependencies []:
  - @renderify/ir@0.6.1
  - @renderify/security@0.6.1

## 0.6.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.6.0
  - @renderify/security@0.6.0

## 0.5.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.5.0
  - @renderify/security@0.5.0

## 0.4.0

### Minor Changes

- fix renderify

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.4.0
  - @renderify/security@0.4.0

## 0.3.0

### Minor Changes

- fix render and update docs

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.3.0
  - @renderify/security@0.3.0

## 0.2.0

### Minor Changes

- fix renderer

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.2.0
  - @renderify/security@0.2.0

## 0.1.0

### Minor Changes

- implement core

### Patch Changes

- Updated dependencies []:
  - @renderify/ir@0.1.0
  - @renderify/security@0.1.0
