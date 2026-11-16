---
title: Integrations
description: Render Renderify UIs from Vercel AI SDK tools, CopilotKit, assistant-ui, AG-UI agents, and MCP Apps.
---

# Integrations

Agent frameworks already move tool calls and results between your model and
your UI. Renderify fits at the end of that pipe: a tool returns a RuntimePlan,
and your client renders it with `<RenderifyView>` from `@renderify/react`.
Plans are JSON, so they survive any transport, and they are validated and
policy-checked before they render.

```bash
npm install @renderify/react @renderify/ir
```

All examples use one server-side tool, `render_ui`, whose input is a
RuntimePlan. Give the model the shared schema and repair errors from
`@renderify/ir`:

```ts
import {
  acceptRuntimePlanCandidate,
  createRuntimePlanJsonSchema,
  RUNTIME_PLAN_INTERACTION_GUIDANCE,
  type RuntimePlan,
} from "@renderify/ir";

// JSON Schema for the tool input (declarative plans only).
const planSchema = createRuntimePlanJsonSchema({ includeSource: false });

// Tool execution: returns the normalized plan, or errors the model can fix.
function renderUi(candidate: unknown) {
  const accepted = acceptRuntimePlanCandidate(candidate);
  return accepted.valid ? { plan: accepted.plan } : { errors: accepted.errors };
}
```

Add `RUNTIME_PLAN_INTERACTION_GUIDANCE` to your system prompt so the model
knows how to express lists, conditions, forms, and events.

## Vercel AI SDK

Verified with `ai` 7, `@ai-sdk/react` 4, and Next.js 16. The
[Next.js chat template](https://github.com/webllm/renderify/tree/main/templates/nextjs-chat)
is a complete app.

```ts
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, type JSONSchema7, jsonSchema, stepCountIs, streamText, tool, type UIMessage } from "ai";

const render_ui = tool({
  description: "Show the user an interactive UI described by a Renderify RuntimePlan.",
  inputSchema: jsonSchema<Record<string, unknown>>(planSchema as JSONSchema7),
  execute: async (candidate) => renderUi(candidate),
});

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();
  return streamText({
    model: openai("gpt-5-mini"),
    system: RUNTIME_PLAN_INTERACTION_GUIDANCE,
    messages: await convertToModelMessages(messages),
    tools: { render_ui },
    stopWhen: stepCountIs(4), // lets the model repair a rejected plan
  }).toUIMessageStreamResponse();
}
```

```tsx
// In your chat component, for each part of message.parts:
if (part.type === "tool-render_ui" && part.state === "output-available") {
  const output = part.output as { plan?: RuntimePlan };
  return output.plan ? <RenderifyView plan={output.plan} /> : null;
}
```

## CopilotKit

For CopilotKit v2, register a renderer for the backend tool with
`useRenderTool`. The result arrives as a string:

```tsx
import { useRenderTool } from "@copilotkit/react-core/v2";
import { RenderifyView } from "@renderify/react";
import { z } from "zod";

function RenderUiTool() {
  useRenderTool(
    {
      name: "render_ui",
      parameters: z.object({}).passthrough(),
      render: ({ status, result }) => {
        if (status !== "complete" || !result) {
          return <p>Building an interactive answer…</p>;
        }
        const output = JSON.parse(result) as { plan?: RuntimePlan };
        return output.plan ? <RenderifyView plan={output.plan} /> : null;
      },
    },
    [],
  );
  return null;
}
```

## assistant-ui

In assistant-ui 0.15, renderers belong on toolkit entries. A backend tool
needs only `type` and `render`:

```tsx
import {
  AssistantRuntimeProvider,
  AuiConfig,
  defineToolkit,
  Tools,
} from "@assistant-ui/react";
import { RenderifyView } from "@renderify/react";

const toolkit = defineToolkit({
  render_ui: {
    type: "backend",
    render: ({ result, status }) => {
      const plan = (result as { plan?: RuntimePlan } | undefined)?.plan;
      if (status.type === "running" || !plan) {
        return <p>Building an interactive answer…</p>;
      }
      return <RenderifyView plan={plan} />;
    },
  },
});

// <AssistantRuntimeProvider runtime={runtime} config={AuiConfig({ tools: Tools({ toolkit }) })}>
```

`makeAssistantToolUI` still works but is deprecated in favor of toolkits.

## AG-UI

With an AG-UI agent, read tool results from the event stream. In
`@ag-ui/client` 1.0, map tool call ids to names from `TOOL_CALL_START`, then
parse the matching `TOOL_CALL_RESULT` content:

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({ url: "/api/agent" });
const toolNames = new Map<string, string>();

await agent.runAgent(
  {},
  {
    onToolCallStartEvent({ event }) {
      toolNames.set(event.toolCallId, event.toolCallName);
    },
    onToolCallResultEvent({ event }) {
      if (toolNames.get(event.toolCallId) === "render_ui") {
        const output = JSON.parse(event.content) as { plan?: RuntimePlan };
        if (output.plan) {
          showPlan(event.toolCallId, output.plan); // render with <RenderifyView>
        }
      }
    },
  },
);
```

## MCP Apps

MCP servers can return plans that hosts render in a sandboxed view, with no
client code at all. Use `@renderify/mcp-app`; the
[MCP server template](https://github.com/webllm/renderify/tree/main/templates/mcp-server)
is a working task board whose form and buttons call allowlisted server tools.
To let the model write JSX instead, register the app with `sourceMode: true`;
the view then renders source in a sandboxed frame nested inside it
([details](https://github.com/webllm/renderify/tree/main/packages/mcp-app#source-mode)).

## Model-written source

When a plan is not expressive enough and the model writes JSX, render it with
`<RenderifyFrame source={code} />` instead of `<RenderifyView>`. It runs the
code in an opaque-origin [sandboxed frame](./sandboxed-frame.md), and only the
action types you allow reach your app.

## Reacting to user input

`<RenderifyView onEvent>` reports every event after its transitions run, with
the new state. Forward the ones you care about to your agent, for example as a
follow-up message, to close the loop:

```tsx
<RenderifyView
  plan={plan}
  onEvent={(event, state) => {
    if (event.type === "submit-order") {
      sendMessage({ text: `Order submitted: ${JSON.stringify(state)}` });
    }
  }}
/>
```
