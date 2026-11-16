import { openai } from "@ai-sdk/openai";
import {
  acceptRuntimePlanCandidate,
  createRuntimePlanJsonSchema,
  RUNTIME_PLAN_INTERACTION_GUIDANCE,
  type RuntimePlan,
} from "@renderify/ir";
import {
  convertToModelMessages,
  type JSONSchema7,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";

export const maxDuration = 60;

/** What the `render_ui` tool returns; the page renders `plan`. */
export type RenderUiOutput = { plan: RuntimePlan } | { errors: string[] };

const SYSTEM_PROMPT = [
  "You are a helpful assistant that can answer with interactive UI.",
  "When a visual or interactive answer helps (forms, lists, calculators, dashboards, comparisons), call render_ui with a Renderify RuntimePlan and keep any text reply to one sentence.",
  'A RuntimePlan is JSON like {"specVersion":"runtime-plan/v1","id":"budget-planner","version":1,"capabilities":{"domWrite":true},"root":{...},"state":{"initial":{...},"transitions":{...}}}. Use declarative nodes only and never include source code.',
  RUNTIME_PLAN_INTERACTION_GUIDANCE,
  "If render_ui returns errors, fix the plan and call it again.",
].join("\n");

const renderUi = tool({
  description:
    "Show the user an interactive UI described by a declarative Renderify RuntimePlan.",
  // The same schema Renderify sends to every provider, without source code.
  inputSchema: jsonSchema<Record<string, unknown>>(
    createRuntimePlanJsonSchema({ includeSource: false }) as JSONSchema7,
  ),
  // Validation errors go back to the model so it can repair the plan.
  execute: async (candidate): Promise<RenderUiOutput> => {
    const accepted = acceptRuntimePlanCandidate(candidate);
    return accepted.valid
      ? { plan: accepted.plan }
      : { errors: accepted.errors };
  },
});

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();
  const result = streamText({
    model: openai(process.env.OPENAI_MODEL ?? "gpt-5-mini"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: { render_ui: renderUi },
    stopWhen: stepCountIs(4),
  });
  return result.toUIMessageStreamResponse();
}
