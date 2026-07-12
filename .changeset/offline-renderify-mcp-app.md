---
"@renderify/mcp-app": minor
"@renderify/ir": patch
"@renderify/security": patch
"@renderify/runtime": patch
---

Add an official MCP Apps adapter for self-contained, offline declarative
RuntimePlans. Share declarative event parsing across IR, security, and runtime,
and lazy-load the source import lexer so strict browser CSP does not initialize
WebAssembly for declarative-only plans.
