import assert from "node:assert/strict";
import test from "node:test";
import type { LLMInterpreter } from "../packages/core/src/llm-interpreter";
import {
  createDefaultLLMProviderRegistry,
  createLLMInterpreter,
  OpenAILLMInterpreter,
} from "../packages/llm/src/index";

test("openai interpreter generates text response", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    baseUrl: "https://example.openai.test/v1",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return jsonResponse({
        id: "chatcmpl_text_1",
        model: "gpt-4.1-mini",
        usage: {
          total_tokens: 42,
        },
        choices: [
          {
            message: {
              content: "runtime text response",
            },
          },
        ],
      });
    },
  });

  llm.setPromptTemplate("default", "You are Renderify test runtime.");

  const response = await llm.generateResponse({
    prompt: "build runtime card",
    context: {
      tenantId: "t1",
    },
  });

  assert.equal(response.text, "runtime text response");
  assert.equal(response.model, "gpt-4.1-mini");
  assert.equal(response.tokensUsed, 42);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.openai.test/v1/chat/completions",
  );
  assert.equal(requests[0].body.model, "gpt-4.1-mini");

  const messages = requests[0].body.messages as Array<{ role: string }>;
  assert.ok(Array.isArray(messages));
  assert.equal(messages[0].role, "system");
  assert.equal(messages[messages.length - 1].role, "user");
});

test("openai interpreter validates structured runtime plan response", async () => {
  const requests: Array<Record<string, unknown>> = [];

  const plan = {
    id: "openai_runtime_plan_1",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [
        {
          type: "text",
          value: "structured openai plan",
        },
      ],
    },
  };

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));

      return jsonResponse({
        id: "chatcmpl_structured_1",
        model: "gpt-4.1-mini",
        usage: {
          total_tokens: 111,
        },
        choices: [
          {
            message: {
              content: JSON.stringify(plan),
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build structured runtime plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.equal(response.model, "gpt-4.1-mini");
  assert.equal(response.tokensUsed, 111);
  assert.deepEqual(response.value, plan);

  const responseFormat = requests[0].response_format as {
    type: string;
    json_schema?: { name?: string; strict?: boolean };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.name, "runtime_plan");
  assert.equal(responseFormat.json_schema?.strict, true);
});

test("openai interpreter marks invalid structured JSON as invalid result", async () => {
  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return jsonResponse({
        id: "chatcmpl_structured_2",
        model: "gpt-4.1-mini",
        choices: [
          {
            message: {
              content: "{not_json",
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build broken plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.ok(Array.isArray(response.errors));
  assert.match(
    String(response.errors?.[0] ?? ""),
    /Structured JSON parse failed/,
  );
});

test("openai interpreter accepts fenced json in structured mode", async () => {
  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return jsonResponse({
        id: "chatcmpl_structured_3",
        model: "gpt-4.1-mini",
        choices: [
          {
            message: {
              content: [
                "```json\n",
                '{"id":"fenced_plan","version":1,"capabilities":{"domWrite":true},"root":{"type":"text","value":"ok"}}',
                "\n```",
              ].join(""),
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build fenced plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.equal((response.value as { id?: string }).id, "fenced_plan");
});

test("llm provider registry can create builtin openai interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "openai",
    providerOptions: {
      apiKey: "test-key",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          id: "chatcmpl_provider_openai",
          model: "gpt-4.1-mini",
          choices: [{ message: { content: "ok" } }],
        }),
    },
  });

  assert.ok(llm instanceof OpenAILLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });
  assert.equal(response.text, "ok");
});

test("llm provider registry supports custom provider registration", async () => {
  class DemoLLMInterpreter implements LLMInterpreter {
    configure(): void {}
    async generateResponse(): Promise<{ text: string }> {
      return { text: "demo-provider" };
    }
    setPromptTemplate(): void {}
    getPromptTemplate(): string | undefined {
      return undefined;
    }
  }

  const registry = createDefaultLLMProviderRegistry();
  registry.register({
    name: "demo",
    create: () => new DemoLLMInterpreter(),
  });

  const llm = createLLMInterpreter({
    provider: "demo",
    registry,
  });

  const response = await llm.generateResponse({
    prompt: "ignored",
  });
  assert.equal(response.text, "demo-provider");
});

test("llm provider registry throws clear error for unknown provider", async () => {
  assert.throws(
    () =>
      createLLMInterpreter({
        provider: "unknown-provider",
      }),
    /Unknown LLM provider: unknown-provider\./,
  );
});

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("request body must be a JSON string");
  }

  return JSON.parse(body) as Record<string, unknown>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
