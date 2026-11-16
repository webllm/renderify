---
"@renderify/runtime": minor
"@renderify/frame": minor
---

Faster browser cold starts. In browsers, remote module responses are shared document-wide (pinned versions for the document's life, ranges for 10 minutes), so preflight, materialization, and re-renders stop refetching the same modules; auto-pin `package.json` and latest-version lookups are shared the same way, and `seedPlaygroundBrowserModules()` keeps auto-pinning from resolving framework packages the browser path replaces. Re-rendering the website's React + Material UI sample dropped from about 3.3 s to about 60 ms, and its Preact sample's first render from about 5 s to about 2.6 s. `@renderify/frame` adds a declarative-only runner (`runner: "plan"`, 59 KiB gzip, no Babel) and a loading placeholder for source renders.
