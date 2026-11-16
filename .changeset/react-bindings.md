---
"@renderify/react": minor
"@renderify/runtime": patch
---

New package: `@renderify/react` with `<RenderifyView>` (renders a validated RuntimePlan and keeps it interactive, remounting only when the plan's content changes), `<RenderifyFrame>` (runs model-written JSX in a `@renderify/frame` sandbox), and `useRenderifySession`. The runtime now marks its runtime-only dynamic imports with `webpackIgnore`, so Next.js (Turbopack and webpack) builds apps that import it. The repository adds a Next.js chat template (Vercel AI SDK) and an MCP server template, an integrations guide for the AI SDK, CopilotKit, assistant-ui, and AG-UI, and a Getting Started that begins with `npm install`.
