# @renderify/frame

## 0.11.0

### Minor Changes

- 0553ac5: Faster browser cold starts. In browsers, remote module responses are shared document-wide (pinned versions for the document's life, ranges for 10 minutes), so preflight, materialization, and re-renders stop refetching the same modules; auto-pin `package.json` and latest-version lookups are shared the same way, and `seedPlaygroundBrowserModules()` keeps auto-pinning from resolving framework packages the browser path replaces. Re-rendering the website's React + Material UI sample dropped from about 3.3 s to about 60 ms, and its Preact sample's first render from about 5 s to about 2.6 s. `@renderify/frame` adds a declarative-only runner (`runner: "plan"`, 59 KiB gzip, no Babel) and a loading placeholder for source renders.
- 09d4b27: New package: `@renderify/frame` runs model-written JSX, TSX, and RuntimePlans in an opaque-origin `sandbox="allow-scripts"` iframe with a strict CSP, a parent-only MessagePort handshake, an action allowlist, transpile-time loop guards, a render watchdog that replaces hung frames, auto-sizing, theme variables, and an SRI-pinned runner, which `runnerSource` can inline where the frame must not fetch scripts. The website Playground now uses it.
