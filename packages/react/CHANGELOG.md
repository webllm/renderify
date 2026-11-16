# @renderify/react

## 0.11.0

### Minor Changes

- 5fdbd52: New package: `@renderify/react` with `<RenderifyView>` (renders a validated RuntimePlan and keeps it interactive, remounting only when the plan's content changes), `<RenderifyFrame>` (runs model-written JSX in a `@renderify/frame` sandbox), and `useRenderifySession`. The runtime now marks its runtime-only dynamic imports with `webpackIgnore`, so Next.js (Turbopack and webpack) builds apps that import it. The repository adds a Next.js chat template (Vercel AI SDK) and an MCP server template, an integrations guide for the AI SDK, CopilotKit, assistant-ui, and AG-UI, and a Getting Started that begins with `npm install`.

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
