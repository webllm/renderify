---
"@renderify/mcp-app": minor
"@renderify/ir": patch
"@renderify/security": patch
"@renderify/runtime": patch
---

Add an official MCP Apps adapter for self-contained, offline declarative
RuntimePlans. Share declarative event parsing across IR, security, and runtime,
classify relative URL references so the MCP boundary can reject navigation and
resource paths, including control-character-obfuscated navigation protocols,
reject browser-managed SVG animation and timed mutation elements before they can
change sanitized URL attributes, and lazy-load the source import lexer so strict
browser CSP does not initialize WebAssembly for declarative-only plans. Treat
cancellation and teardown as terminal so delayed tool responses cannot
reactivate a view.
Treat app-called tool error results as failures without rendering their
structured plan. Reuse the declarative renderer across replacement plans and
detach delegated DOM listeners when the view ends. Normalize custom browser
bundle line endings before hashing and reject explicitly empty bundles. Include
support for relative view entries by using the configured or current working
directory as the bundler base. Include the repository MIT license in the
published package.
