---
"@renderify/mcp-app": minor
---

Migrate to MCP SDK v2 and `@modelcontextprotocol/ext-apps` 2.x. Install `@modelcontextprotocol/server` instead of `@modelcontextprotocol/sdk`, and use zod 4.2 or newer. Tool handlers now receive the v2 `ServerContext` (`mcpReq.signal`, `mcpReq.id`, `sessionId`, `http?.authInfo`). The `ui/*` wire protocol is unchanged, so Renderify views keep working in both 1.x and 2.x MCP Apps hosts.
