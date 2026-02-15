# Visual Architecture (Mermaid)

This document provides visual diagrams for the main Renderify architecture paths.

## End-to-End Pipeline

```mermaid
flowchart LR
  A[Prompt or RuntimePlan] --> B[CodeGen]
  B --> C[RuntimePlan IR]
  C --> D[Security Checker]
  D --> E[Runtime Manager]
  E --> F[UI Renderer]
  F --> G[DOM Output]

  E --> H[JSPM Module Loader]
  H --> I[Primary CDN]
  H --> J[Fallback CDNs]
```

## Package Dependency Map

```mermaid
graph TD
  R[renderify] --> C[@renderify/core]
  R --> IR[@renderify/ir]
  R --> RT[@renderify/runtime]
  R --> S[@renderify/security]
  R --> L[@renderify/llm]

  C --> IR
  C --> RT
  C --> S

  RT --> IR
  RT --> S

  S --> IR

  CLI[@renderify/cli] --> R
  CLI --> C
  CLI --> L
  CLI --> RT
```

## Runtime Source Execution Path

```mermaid
flowchart TD
  A[plan.source code] --> B[Transpile TSX or JSX]
  B --> C[Extract imports]
  C --> D[Resolve specifiers]
  D --> E[Fetch remote modules]
  E --> F[Rewrite nested imports]
  F --> G[Create blob URLs]
  G --> H[dynamic import]
  H --> I[Export function or node]
  I --> J[Render artifact or RuntimeNode]
```

## Sandbox Decision Flow

```mermaid
flowchart TD
  A[Source execution requested] --> B{Sandbox mode}

  B -->|none| C[Main thread execution]
  B -->|worker| D[Worker sandbox]
  B -->|iframe| E[Iframe sandbox]
  B -->|shadowrealm| F[ShadowRealm sandbox]

  F --> G{ShadowRealm available?}
  G -->|yes| H[Execute in ShadowRealm]
  G -->|no| I[Fallback chain]
  I --> D
  I --> E

  D --> J{Timeout or abort?}
  E --> J
  H --> J

  J -->|no| K[Return result]
  J -->|yes| L[AbortError or timeout error]
```

## Defense-in-Depth Security Layers

```mermaid
flowchart TB
  A[Layer 1: Policy pre-check]
  B[Layer 2: Module host and manifest constraints]
  C[Layer 3: Runtime sandbox isolation]
  D[Layer 4: UI sanitization]

  A --> B --> C --> D
```

## Notes

- The diagrams intentionally show control flow, not every internal helper.
- For type-level details, see [`docs/api-reference.md`](./api-reference.md).
- For execution semantics, see [`docs/runtime-execution.md`](./runtime-execution.md).
