---
title: Architecture decision records
description: Durable records of important Renderify architecture and security boundary decisions.
---

# Architecture Decision Records

- [ADR-0001 — Offline declarative MCP App boundary](./0001-offline-declarative-mcp-app-boundary.md) - Use the official SDK and exclude runtime source and external modules from the first release.
- [ADR-0002 — Sandboxed source frame](./0002-sandboxed-source-frame.md) - Run model-written source in an opaque-origin iframe owned by the SDK, and in MCP Apps only inside a frame nested in the view when an app opts in.
