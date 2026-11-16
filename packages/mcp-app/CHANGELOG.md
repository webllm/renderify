# @renderify/mcp-app

## 0.11.0

### Minor Changes

- af7d8bf: Declarative plans can now build real forms and lists without source code.

  - New `each` and `if` RuntimeNodes repeat or conditionally render children, with loop variables (`{{todo.title}}`, `{{index}}`), item keys, and a 10,000-node expansion cap.
  - `bind` keeps an input, textarea, or select in sync with a state path; events from form controls carry their live value in `event.payload.value`; `onEnter` fires on Enter in a field.
  - `form` nodes render as inert containers with emulated submit: `onSubmit` receives the form's named fields. Password and file inputs are never captured.
  - New `remove` action, array-aware paths (`todos.2.done`), whole-segment path templates (`todos.{{event.payload.index}}.done`), and `{"$from"}` references at any depth in action values and event payloads, resolved when the event is handled.
  - MCP Apps pass those resolved payloads as tool arguments and debounce model-context updates from bound inputs.
  - The shared LLM schema, repair diagnostics, and system prompts teach models the new vocabulary.

- 6a80178: Migrate to MCP SDK v2 and `@modelcontextprotocol/ext-apps` 2.x. Install `@modelcontextprotocol/server` instead of `@modelcontextprotocol/sdk`, and use zod 4.2 or newer. Tool handlers now receive the v2 `ServerContext` (`mcpReq.signal`, `mcpReq.id`, `sessionId`, `http?.authInfo`). The `ui/*` wire protocol is unchanged, so Renderify views keep working in both 1.x and 2.x MCP Apps hosts.
- 09d4b27: Apps registered with `sourceMode: true` can return model-written JSX or TSX (`{ source }` from the handler, or `renderifySourceResult`). The view renders it in a sandboxed `@renderify/frame` nested inside it, never in its own window, and the frame reaches server tools only through `allowedTools`. Such resources inline the frame runner, allow it by hash plus `blob:` and the module CDNs in their CSP, and declare those CDNs in `_meta.ui.csp`. Apps without source mode are unchanged and reject source results.

### Patch Changes

- Updated dependencies [8086c6b]
- Updated dependencies [0553ac5]
- Updated dependencies [af7d8bf]
- Updated dependencies [5fdbd52]
- Updated dependencies [09d4b27]
- Updated dependencies [0b2c7e6]
  - @renderify/runtime@0.11.0
  - @renderify/frame@0.11.0
  - @renderify/ir@0.11.0
  - @renderify/security@0.11.0

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
