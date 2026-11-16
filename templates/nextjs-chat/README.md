# Renderify Next.js chat template

A chat app where the model can answer with interactive UI. It uses the Vercel
AI SDK for the chat and `@renderify/react` to render the model's UIs.

## How it works

1. `app/api/chat/route.ts` gives the model a `render_ui` tool. Its input schema
   is Renderify's RuntimePlan schema (declarative plans only), and its
   `execute` validates the plan with `acceptRuntimePlanCandidate`. Invalid
   plans return errors the model can fix in the next step.
2. `app/page.tsx` renders `tool-render_ui` message parts with
   `<RenderifyView>`, which checks the plan against the `balanced` security
   profile and renders it. Lists, forms, and buttons in the plan work locally
   without another model call.

No model-written code runs: plans are JSON, validated twice. To let the model
write JSX instead, render it with `<RenderifyFrame>`, which uses a sandboxed
iframe.

## Run

```bash
cp .env.example .env.local   # add your OPENAI_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3000 and ask for something interactive, such as "Plan a
weekly budget with editable categories".

`OPENAI_MODEL` selects any OpenAI model with tool calling (`gpt-5-mini` by
default). To use another provider, swap `@ai-sdk/openai` for its AI SDK
provider in `route.ts`.

## Copying this template

Inside the Renderify repository the `@renderify/*` dependencies use
`workspace:^`, and the repository must be built first (`pnpm build` at the
root). In your own project, replace them with the published version, for
example `"@renderify/react": "^0.11.0"`.
