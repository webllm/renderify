---
"@renderify/mcp-app": minor
---

Apps registered with `sourceMode: true` can return model-written JSX or TSX (`{ source }` from the handler, or `renderifySourceResult`). The view renders it in a sandboxed `@renderify/frame` nested inside it, never in its own window, and the frame reaches server tools only through `allowedTools`. Such resources inline the frame runner, allow it by hash plus `blob:` and the module CDNs in their CSP, and declare those CDNs in `_meta.ui.csp`. Apps without source mode are unchanged and reject source results.
