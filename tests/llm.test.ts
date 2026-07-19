import assert from "node:assert/strict";
import test from "node:test";
import type { LLMInterpreter } from "../packages/core/src/llm-interpreter";
import {
  AnthropicLLMInterpreter,
  createDefaultLLMProviderRegistry,
  createLLMInterpreter,
  GoogleLLMInterpreter,
  LMStudioLLMInterpreter,
  OllamaLLMInterpreter,
  OpenAICodexLLMInterpreter,
  type OpenAICodexReasoningEffort,
  OpenAILLMInterpreter,
} from "../packages/llm/src/index";

test("llm package exports Codex reasoning effort values", () => {
  const reasoningEfforts: OpenAICodexReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];

  assert.deepEqual(reasoningEfforts, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("openai interpreter generates text response", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    model: "gpt-5-mini",
    baseUrl: "https://example.openai.test/v1",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return jsonResponse({
        id: "chatcmpl_text_1",
        model: "gpt-5-mini",
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
  assert.equal(response.model, "gpt-5-mini");
  assert.equal(response.tokensUsed, 42);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.openai.test/v1/chat/completions",
  );
  assert.equal(requests[0].body.model, "gpt-5-mini");

  const messages = requests[0].body.messages as Array<{ role: string }>;
  assert.ok(Array.isArray(messages));
  assert.equal(messages[0].role, "system");
  assert.equal(messages[messages.length - 1].role, "user");
});

test("openai interpreter streams text response chunks", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    model: "gpt-5-mini",
    baseUrl: "https://example.openai.test/v1",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return sseResponse([
        `data: ${JSON.stringify({
          id: "chatcmpl_stream_1",
          model: "gpt-5-mini",
          choices: [{ delta: { content: "hello " } }],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl_stream_1",
          model: "gpt-5-mini",
          choices: [{ delta: { content: "world" } }],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl_stream_1",
          model: "gpt-5-mini",
          usage: { total_tokens: 77 },
          choices: [],
        })}`,
        "data: [DONE]",
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream({
    prompt: "stream this",
  })) {
    chunks.push(chunk);
  }

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.openai.test/v1/chat/completions",
  );
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, {
    include_usage: true,
  });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].delta, "hello ");
  assert.equal(chunks[0].text, "hello ");
  assert.equal(chunks[0].done, false);
  assert.equal(chunks[1].delta, "world");
  assert.equal(chunks[1].text, "hello world");
  assert.equal(chunks[1].done, false);
  assert.equal(chunks[2].done, true);
  assert.equal(chunks[2].text, "hello world");
  assert.equal(chunks[2].tokensUsed, 77);
});

test("openai interpreter retries transient network errors", async () => {
  let attempt = 0;

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    model: "gpt-5-mini",
    baseUrl: "https://example.openai.test/v1",
    reliability: {
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      retryJitterMs: 0,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerCooldownMs: 1000,
    },
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("temporary network fault");
      }

      return jsonResponse({
        id: "chatcmpl_retry_1",
        model: "gpt-5-mini",
        choices: [
          {
            message: {
              content: "recovered",
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateResponse({
    prompt: "retry request",
  });

  assert.equal(response.text, "recovered");
  assert.equal(attempt, 2);
});

test("openai interpreter opens circuit breaker after repeated failures", async () => {
  let attempt = 0;

  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    baseUrl: "https://example.openai.test/v1",
    reliability: {
      maxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      retryJitterMs: 0,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerCooldownMs: 60000,
    },
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempt += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "service unavailable",
          },
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  await assert.rejects(
    () =>
      llm.generateResponse({
        prompt: "trip breaker",
      }),
    /OpenAI request failed \(503\)/,
  );

  assert.equal(attempt, 1);

  await assert.rejects(
    () =>
      llm.generateResponse({
        prompt: "trip breaker again",
      }),
    /circuit breaker is open/,
  );

  assert.equal(attempt, 1);
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
        model: "gpt-5-mini",
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
  assert.equal(response.model, "gpt-5-mini");
  assert.equal(response.tokensUsed, 111);
  assert.deepEqual(response.value, plan);

  const responseFormat = requests[0].response_format as {
    type: string;
    json_schema?: { name?: string; strict?: boolean };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.name, "runtime_plan");
  assert.equal(responseFormat.json_schema?.strict, false);
});

test("openai interpreter marks invalid structured JSON as invalid result", async () => {
  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return jsonResponse({
        id: "chatcmpl_structured_2",
        model: "gpt-5-mini",
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
        model: "gpt-5-mini",
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

test("openai interpreter distinguishes caller abort from timeout", async () => {
  const llm = new OpenAILLMInterpreter({
    apiKey: "test-key",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        throw createAbortError();
      }
      throw new Error("expected aborted signal");
    },
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      llm.generateResponse({
        prompt: "abort request",
        signal: controller.signal,
      }),
    /OpenAI request aborted by caller/,
  );
});

test("openai codex interpreter generates text response", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const accessToken = codexAccessToken("acct_renderify_test");

  const llm = new OpenAICodexLLMInterpreter({
    accessToken,
    model: "gpt-5.5",
    baseUrl: "https://example.codex.test/backend-api/codex",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      });

      return sseResponse([
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_text_1",
              model: "gpt-5.5",
              usage: {
                input_tokens: 12,
                output_tokens: 8,
              },
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: "codex runtime text",
                    },
                  ],
                },
              ],
            },
          }),
      ]);
    },
  });

  llm.setPromptTemplate("default", "You are Renderify Codex runtime.");

  const response = await llm.generateResponse({
    prompt: "build runtime card",
    context: {
      tenantId: "codex-tenant",
    },
  });

  assert.equal(response.text, "codex runtime text");
  assert.equal(response.model, "gpt-5.5");
  assert.equal(response.tokensUsed, 20);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.codex.test/backend-api/codex/responses",
  );
  assert.equal(
    requests[0].headers.get("authorization"),
    `Bearer ${accessToken}`,
  );
  assert.equal(requests[0].headers.get("accept"), "text/event-stream");
  assert.equal(requests[0].headers.get("originator"), "codex_cli_rs");
  assert.equal(
    requests[0].headers.get("chatgpt-account-id"),
    "acct_renderify_test",
  );
  assert.equal(requests[0].body.model, "gpt-5.5");
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.stream, true);
  assert.match(String(requests[0].body.instructions), /Renderify Codex/);
  const inputText = assertCodexInputText(requests[0].body.input);
  assert.match(inputText, /build runtime card/);
  assert.match(inputText, /codex-tenant/);
});

test("openai codex interpreter streams text response chunks", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    model: "gpt-5.5",
    baseUrl: "https://example.codex.test/backend-api/codex",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "hello ",
          }),
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "codex",
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_stream_1",
              model: "gpt-5.5",
              usage: { total_tokens: 31 },
              output_text: "hello codex",
            },
          }),
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream({
    prompt: "stream this",
  })) {
    chunks.push(chunk);
  }

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.codex.test/backend-api/codex/responses",
  );
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.store, false);
  assert.equal(
    requests[0].body.instructions,
    "You are Renderify Codex runtime.",
  );
  assert.equal(assertCodexInputText(requests[0].body.input), "stream this");
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].delta, "hello ");
  assert.equal(chunks[0].text, "hello ");
  assert.equal(chunks[1].delta, "codex");
  assert.equal(chunks[1].text, "hello codex");
  assert.equal(chunks[2].done, true);
  assert.equal(chunks[2].text, "hello codex");
  assert.equal(chunks[2].tokensUsed, 31);
});

test("openai codex interpreter rejects response.failed with response error details", async () => {
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.failed\ndata: " +
          JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_codex_failed_1",
              status: "failed",
              error: {
                code: "server_error",
                message: "The model failed to generate a response.",
              },
            },
          }),
      ]),
  });

  await assert.rejects(
    () => llm.generateResponse({ prompt: "fail this response" }),
    /OpenAI Codex response failed \(server_error\): The model failed to generate a response\./,
  );
});

test("openai codex streaming rejects response.failed instead of emitting done", async () => {
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.failed\ndata: " +
          JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_codex_stream_failed_1",
              status: "failed",
              error: {
                code: "model_error",
                message: "Generation stopped unexpectedly.",
              },
            },
          }),
      ]),
  });

  let sawDone = false;
  await assert.rejects(async () => {
    for await (const chunk of llm.generateResponseStream({
      prompt: "stream failure",
    })) {
      sawDone ||= chunk.done;
    }
  }, /OpenAI Codex response failed \(model_error\): Generation stopped unexpectedly\./);
  assert.equal(sawDone, false);
});

test("openai codex streaming preserves top-level error event details", async () => {
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: error\ndata: " +
          JSON.stringify({
            type: "error",
            code: "invalid_prompt",
            message: "Prompt input was rejected.",
            param: "input",
          }),
      ]),
  });

  await assert.rejects(async () => {
    for await (const _chunk of llm.generateResponseStream({
      prompt: "invalid stream prompt",
    })) {
      // The error event must terminate the stream without yielding success.
    }
  }, /OpenAI Codex stream error \(invalid_prompt\): Prompt input was rejected\. \[param: input\]/);
});

test("openai codex interpreter validates structured runtime plan response", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const plan = {
    id: "codex_runtime_plan_1",
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
          value: "structured codex plan",
        },
      ],
    },
  };

  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));
      return sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(plan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_structured_1",
              model: "gpt-5.5",
              usage: {
                total_tokens: 64,
              },
            },
          }),
      ]);
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build structured runtime plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.equal(response.model, "gpt-5.5");
  assert.equal(response.tokensUsed, 64);
  assert.deepEqual(response.value, plan);

  const textConfig = requests[0].text as {
    format?: { type?: string; name?: string; strict?: boolean };
  };
  assert.equal(textConfig.format?.type, "json_schema");
  assert.equal(textConfig.format?.name, "runtime_plan");
  assert.equal(textConfig.format?.strict, false);
  assert.equal(requests[0].stream, true);
  assert.equal(
    assertCodexInputText(requests[0].input),
    "build structured runtime plan",
  );
});

test("openai codex normalizes DOM-like plans and uses low reasoning for Spark", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const domLikePlan = {
    specVersion: "runtime-plan/v1",
    id: "codex_dom_like_plan",
    version: 1,
    root: {
      type: "div",
      props: { style: { color: "green" } },
      children: [{ type: "span", children: ["Healthy"] }],
    },
    capabilities: { domWrite: true },
  };
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    model: "gpt-5.3-codex-spark",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));
      return sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(domLikePlan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_dom_like",
              model: "gpt-5.3-codex-spark",
            },
          }),
      ]);
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a status card",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  const normalized = response.value as {
    root?: { type?: string; tag?: string; children?: unknown[] };
  };
  assert.equal(normalized.root?.type, "element");
  assert.equal(normalized.root?.tag, "div");
  assert.deepEqual(requests[0].reasoning, { effort: "low" });
  const schema = (
    requests[0].text as {
      format?: {
        schema?: {
          additionalProperties?: boolean;
          properties?: {
            root?: {
              additionalProperties?: boolean;
              properties?: {
                type?: { enum?: string[] };
                children?: {
                  items?: {
                    additionalProperties?: boolean;
                    properties?: { type?: { enum?: string[] } };
                  };
                };
              };
            };
            capabilities?: {
              properties?: Record<string, unknown>;
            };
            state?: { required?: string[] };
          };
        };
      };
    }
  ).format?.schema;
  assert.equal(schema?.additionalProperties, false);
  assert.deepEqual(schema?.properties?.root?.properties?.type?.enum, [
    "text",
    "element",
    "component",
  ]);
  assert.equal(
    schema?.properties?.root?.properties?.children?.items?.additionalProperties,
    false,
  );
  assert.deepEqual(
    schema?.properties?.root?.properties?.children?.items?.properties?.type
      ?.enum,
    ["text", "element", "component"],
  );
  assert.deepEqual(schema?.properties?.state?.required, ["initial"]);
  const stateSchema = schema?.properties?.state as
    | {
        properties?: {
          transitions?: {
            additionalProperties?: {
              items?: {
                additionalProperties?: boolean;
                required?: string[];
              };
            };
          };
        };
      }
    | undefined;
  const actionSchema =
    stateSchema?.properties?.transitions?.additionalProperties?.items;
  assert.equal(actionSchema?.additionalProperties, false);
  assert.deepEqual(actionSchema?.required, ["type", "path"]);
  assert.deepEqual(
    Object.keys(schema?.properties?.capabilities?.properties ?? {}),
    ["domWrite"],
  );
  assert.equal(
    Object.hasOwn(
      schema?.properties?.capabilities?.properties ?? {},
      "maxExecutionMs",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      schema?.properties?.capabilities?.properties ?? {},
      "maxComponentInvocations",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      schema?.properties?.capabilities?.properties ?? {},
      "maxImports",
    ),
    false,
  );
  assert.equal(
    (response.raw as { normalized?: boolean } | undefined)?.normalized,
    true,
  );
  assert.match(
    String(requests[0].instructions),
    /Runtime template syntax is \{\{state\.path\}\}/,
  );
  assert.match(String(requests[0].instructions), /Never use \$\{\.\.\.\}/);
});

test("openai codex rejects plans with present invalid semantic fields", async () => {
  const invalidPlan = {
    specVersion: "runtime-plan/v1",
    id: "codex_invalid_source_plan",
    version: 1,
    root: {
      type: "component",
      module: "this-plan-source",
    },
    capabilities: { domWrite: true },
    source: {
      language: "tsx",
      code: "export default () => <div />",
      runtime: "react",
    },
  };
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(invalidPlan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_invalid_source",
              model: "gpt-5.5",
            },
          }),
      ]),
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a source-backed plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.deepEqual(response.value, invalidPlan);
  assert.deepEqual(response.errors, [
    "Structured payload is not a valid RuntimePlan",
    'source.runtime must be "renderify" or "preact"; omit source for declarative plans',
  ]);
});

test("openai codex reports actionable nested RuntimePlan errors", async () => {
  const invalidPlan = {
    specVersion: "runtime-plan/v1",
    id: "codex_invalid_nested_plan",
    version: 1,
    root: {
      type: "element",
      tag: "div",
      children: [
        {
          type: "text",
          value: "Todo List",
          style: { fontSize: "22px" },
        },
      ],
    },
    capabilities: { domWrite: true },
    state: {},
  };
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(invalidPlan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_invalid_nested",
              model: "gpt-5.5",
            },
          }),
      ]),
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a todo list",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.deepEqual(response.errors, [
    "Structured payload is not a valid RuntimePlan",
    "root.children[0].style is invalid on a text node; wrap it in an element and use props.style",
    "state must contain an initial object and optional valid transitions; omit state when unused",
  ]);
});

test("openai codex rejects plan fields misplaced inside root", async () => {
  const invalidPlan = {
    specVersion: "runtime-plan/v1",
    id: "codex_misplaced_state_plan",
    version: 1,
    root: {
      type: "element",
      tag: "main",
      children: [{ type: "text", value: "Count" }],
      state: { initial: { count: 0 } },
      capabilities: { domWrite: true },
    },
    capabilities: { domWrite: true },
  };
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(invalidPlan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_misplaced_state",
              model: "gpt-5.5",
            },
          }),
      ]),
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a stateful todo list",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.deepEqual(response.errors, [
    "Structured payload is not a valid RuntimePlan",
    "root.state is not valid on a RuntimeNode; move state to the RuntimePlan top level",
    "root.capabilities is not valid on a RuntimeNode; move capabilities to the RuntimePlan top level",
  ]);
});

test("openai codex rejects unsupported declarative expressions", async () => {
  const invalidPlan = {
    specVersion: "runtime-plan/v1",
    id: "codex_unsupported_expression_plan",
    version: 1,
    root: {
      type: "element",
      tag: "p",
      children: [{ type: "text", value: `已完成: \${completedCount} / 5` }],
    },
    capabilities: { domWrite: true },
  };
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(invalidPlan),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_unsupported_expression",
              model: "gpt-5.5",
            },
          }),
      ]),
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a todo list",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.deepEqual(response.errors, [
    "Structured payload is not a valid RuntimePlan",
    `root.children[0].value uses unsupported \${...} interpolation; use {{state.path}} path templates only`,
  ]);
});

test("openai codex assigns unique fallback plan ids for repeated prompts", async () => {
  let requestCount = 0;
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    model: "gpt-5.3-codex-spark",
    fetchImpl: async () => {
      requestCount += 1;
      const planWithoutId = {
        specVersion: "runtime-plan/v1",
        version: 1,
        root: {
          type: "element",
          tag: "div",
          children: [{ type: "text", value: `render ${requestCount}` }],
        },
        capabilities: { domWrite: true },
      };
      return sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: JSON.stringify(planWithoutId),
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_reused_by_test",
              model: "gpt-5.3-codex-spark",
            },
          }),
      ]);
    },
  });

  const first = await llm.generateStructuredResponse({
    prompt: "same prompt",
    format: "runtime-plan",
    strict: true,
  });
  const second = await llm.generateStructuredResponse({
    prompt: "same prompt",
    format: "runtime-plan",
    strict: true,
  });
  const firstId = (first.value as { id?: unknown } | undefined)?.id;
  const secondId = (second.value as { id?: unknown } | undefined)?.id;

  assert.equal(typeof firstId, "string");
  assert.equal(typeof secondId, "string");
  assert.notEqual(firstId, secondId);
});

test("openai codex assigns unique fallback plan ids across interpreters", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  const createInterpreter = () =>
    new OpenAICodexLLMInterpreter({
      accessToken: "codex-test-token",
      model: "gpt-5.3-codex-spark",
      fetchImpl: async () => {
        const planWithoutId = {
          specVersion: "runtime-plan/v1",
          version: 1,
          root: { type: "text", value: "render" },
          capabilities: { domWrite: true },
        };
        return sseResponse([
          "event: response.output_text.delta\ndata: " +
            JSON.stringify({
              type: "response.output_text.delta",
              delta: JSON.stringify(planWithoutId),
            }),
          "event: response.completed\ndata: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_shared_across_interpreters",
                model: "gpt-5.3-codex-spark",
              },
            }),
        ]);
      },
    });

  try {
    const [first, second] = await Promise.all(
      [createInterpreter(), createInterpreter()].map((llm) =>
        llm.generateStructuredResponse({
          prompt: "same prompt",
          format: "runtime-plan",
          strict: true,
        }),
      ),
    );
    const firstId = (first.value as { id?: unknown } | undefined)?.id;
    const secondId = (second.value as { id?: unknown } | undefined)?.id;

    assert.equal(typeof firstId, "string");
    assert.equal(typeof secondId, "string");
    assert.notEqual(firstId, secondId);
  } finally {
    Date.now = originalNow;
  }
});

test("openai codex reasoning effort override is forwarded", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = parseBody(init?.body);
      return sseResponse([
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_reasoning_override",
              model: "gpt-5.3-codex-spark",
              output_text: "ok",
            },
          }),
      ]);
    },
  });

  await llm.generateResponse({ prompt: "reasoning override" });
  assert.deepEqual(requestBody?.reasoning, { effort: "medium" });
});

test("openai codex rejects reasoning efforts unsupported by Spark", () => {
  assert.throws(
    () =>
      new OpenAICodexLLMInterpreter({
        accessToken: "codex-test-token",
        model: "gpt-5.3-codex-spark",
        reasoningEffort: "max",
      }),
    /Reasoning effort "max" is not supported by gpt-5\.3-codex-spark/,
  );
});

test("openai codex rejects unknown reasoning effort values", () => {
  assert.throws(
    () =>
      new OpenAICodexLLMInterpreter({
        accessToken: "codex-test-token",
        reasoningEffort: "medum" as OpenAICodexReasoningEffort,
      }),
    /Invalid OpenAI Codex reasoning effort "medum"/,
  );
  assert.throws(
    () =>
      new OpenAICodexLLMInterpreter({
        accessToken: "codex-test-token",
        reasoningEffort: 42 as unknown as OpenAICodexReasoningEffort,
      }),
    /reasoning effort must be a string/,
  );
});

test("openai codex structured response rejects incomplete terminal state", async () => {
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    fetchImpl: async () =>
      sseResponse([
        "event: response.incomplete\ndata: " +
          JSON.stringify({
            type: "response.incomplete",
            response: {
              id: "resp_codex_incomplete_1",
              status: "incomplete",
              incomplete_details: {
                reason: "max_output_tokens",
              },
            },
          }),
      ]),
  });

  await assert.rejects(
    () =>
      llm.generateStructuredResponse({
        prompt: "build an oversized runtime plan",
        format: "runtime-plan",
      }),
    /OpenAI Codex response incomplete: max_output_tokens/,
  );
});

test("openai codex interpreter requires an access token", async () => {
  const llm = new OpenAICodexLLMInterpreter({
    fetchImpl: async () => jsonResponse({}),
  });

  await assert.rejects(
    () =>
      llm.generateResponse({
        prompt: "missing token",
      }),
    /OpenAI Codex access token is missing/,
  );
});

test("openai codex interpreter times out stalled streaming responses", async () => {
  let streamCanceled = false;
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    timeoutMs: 20,
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            streamCanceled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
  });

  await assert.rejects(
    () =>
      llm.generateResponse({
        prompt: "stall",
      }),
    /OpenAI Codex request timed out after 20ms/,
  );
  assert.equal(streamCanceled, true);
});

test("openai codex retries one timed-out streaming response", async () => {
  let attempts = 0;
  let stalledStreamCanceled = false;
  const llm = new OpenAICodexLLMInterpreter({
    accessToken: "codex-test-token",
    timeoutMs: 20,
    reliability: { maxRetries: 1 },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              stalledStreamCanceled = true;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }

      return sseResponse([
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "recovered",
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_codex_timeout_recovered",
              model: "gpt-5.3-codex-spark",
            },
          }),
      ]);
    },
  });

  const response = await llm.generateResponse({ prompt: "recover a stall" });

  assert.equal(response.text, "recovered");
  assert.equal(attempts, 2);
  assert.equal(stalledStreamCanceled, true);
});

test("anthropic interpreter generates text response", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];

  const llm = new AnthropicLLMInterpreter({
    apiKey: "anthropic-key",
    model: "claude-sonnet-4-5",
    baseUrl: "https://example.anthropic.test/v1",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      });

      return jsonResponse({
        id: "msg_001",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 9,
          output_tokens: 12,
        },
        content: [
          {
            type: "text",
            text: "anthropic text response",
          },
        ],
      });
    },
  });

  const response = await llm.generateResponse({
    prompt: "build runtime card",
  });

  assert.equal(response.text, "anthropic text response");
  assert.equal(response.model, "claude-sonnet-4-5");
  assert.equal(response.tokensUsed, 21);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.anthropic.test/v1/messages");
  assert.equal(requests[0].headers.get("x-api-key"), "anthropic-key");
  assert.equal(requests[0].headers.get("anthropic-version"), "2023-06-01");
  assert.equal(requests[0].body.model, "claude-sonnet-4-5");
});

test("anthropic interpreter streams text response chunks", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new AnthropicLLMInterpreter({
    apiKey: "anthropic-key",
    model: "claude-sonnet-4-5",
    baseUrl: "https://example.anthropic.test/v1",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return sseResponse([
        "event: message_start\ndata: " +
          JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_stream_1",
              model: "claude-sonnet-4-5",
              usage: { input_tokens: 11 },
            },
          }),
        "event: content_block_delta\ndata: " +
          JSON.stringify({
            type: "content_block_delta",
            delta: { text: "hello " },
          }),
        "event: content_block_delta\ndata: " +
          JSON.stringify({
            type: "content_block_delta",
            delta: { text: "anthropic" },
          }),
        "event: message_delta\ndata: " +
          JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 7 },
          }),
        "event: message_stop\ndata: " +
          JSON.stringify({
            type: "message_stop",
          }),
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream({
    prompt: "stream this",
  })) {
    chunks.push(chunk);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.anthropic.test/v1/messages");
  assert.equal(requests[0].body.stream, true);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].delta, "hello ");
  assert.equal(chunks[0].text, "hello ");
  assert.equal(chunks[1].delta, "anthropic");
  assert.equal(chunks[1].text, "hello anthropic");
  assert.equal(chunks[2].done, true);
  assert.equal(chunks[2].text, "hello anthropic");
  assert.equal(chunks[2].tokensUsed, 18);
});

test("anthropic interpreter validates structured runtime plan response", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const plan = {
    id: "anthropic_runtime_plan_1",
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
          value: "structured anthropic plan",
        },
      ],
    },
  };

  const llm = new AnthropicLLMInterpreter({
    apiKey: "anthropic-key",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));
      return jsonResponse({
        id: "msg_002",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 10,
          output_tokens: 13,
        },
        content: [
          {
            type: "text",
            text: JSON.stringify(plan),
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
  assert.equal(response.model, "claude-sonnet-4-5");
  assert.equal(response.tokensUsed, 23);
  assert.deepEqual(response.value, plan);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "claude-sonnet-4-5");
  assert.ok(Array.isArray(requests[0].tools));
  assert.deepEqual(requests[0].tool_choice, {
    type: "tool",
    name: "runtime_plan",
  });
});

test("anthropic interpreter accepts structured tool_use payload", async () => {
  const plan = {
    specVersion: "runtime-plan/v1",
    id: "anthropic_tool_plan",
    version: 1,
    capabilities: {
      domWrite: true,
      allowedModules: [],
    },
    root: {
      type: "text",
      value: "tool plan",
    },
  };

  const llm = new AnthropicLLMInterpreter({
    apiKey: "anthropic-key",
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: "msg_tool_001",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 12,
          output_tokens: 9,
        },
        content: [
          {
            type: "tool_use",
            id: "toolu_001",
            name: "runtime_plan",
            input: plan,
          },
        ],
      }),
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build structured runtime plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.equal(response.model, "claude-sonnet-4-5");
  assert.equal(response.tokensUsed, 21);
  assert.deepEqual(response.value, plan);
});

test("google interpreter generates text response", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];

  const llm = new GoogleLLMInterpreter({
    apiKey: "google-key",
    model: "gemini-2.5-flash",
    baseUrl: "https://example.google.test/v1beta",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      });

      return jsonResponse({
        modelVersion: "gemini-2.5-flash",
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 11,
        },
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text: "google text response",
                },
              ],
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateResponse({
    prompt: "build runtime card",
  });

  assert.equal(response.text, "google text response");
  assert.equal(response.model, "gemini-2.5-flash");
  assert.equal(response.tokensUsed, 19);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.google.test/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(requests[0].headers.get("x-goog-api-key"), "google-key");
  assert.deepEqual(requests[0].body.generationConfig, {
    responseMimeType: "text/plain",
  });
  assert.equal(requests[0].body.systemInstruction, undefined);
});

test("google interpreter streams text response chunks", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new GoogleLLMInterpreter({
    apiKey: "google-key",
    model: "gemini-2.5-flash",
    baseUrl: "https://example.google.test/v1beta",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return sseResponse([
        "data: " +
          JSON.stringify({
            modelVersion: "gemini-2.5-flash",
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: "hello " }] },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            modelVersion: "gemini-2.5-flash",
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: "google" }] },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            modelVersion: "gemini-2.5-flash",
            usageMetadata: { totalTokenCount: 55 },
            candidates: [],
          }),
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream({
    prompt: "stream this",
  })) {
    chunks.push(chunk);
  }

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.google.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );
  assert.deepEqual(requests[0].body.generationConfig, {
    responseMimeType: "text/plain",
  });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].delta, "hello ");
  assert.equal(chunks[0].text, "hello ");
  assert.equal(chunks[1].delta, "google");
  assert.equal(chunks[1].text, "hello google");
  assert.equal(chunks[2].done, true);
  assert.equal(chunks[2].text, "hello google");
  assert.equal(chunks[2].tokensUsed, 55);
});

test("google interpreter validates structured runtime plan response", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const plan = {
    id: "google_runtime_plan_1",
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
          value: "structured google plan",
        },
      ],
    },
  };

  const llm = new GoogleLLMInterpreter({
    apiKey: "google-key",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));
      return jsonResponse({
        modelVersion: "gemini-2.5-flash",
        usageMetadata: {
          totalTokenCount: 27,
        },
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text: JSON.stringify(plan),
                },
              ],
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
  assert.equal(response.model, "gemini-2.5-flash");
  assert.equal(response.tokensUsed, 27);
  assert.deepEqual(response.value, plan);
  assert.equal(requests.length, 1);
  const generationConfig = requests[0].generationConfig as Record<
    string,
    unknown
  >;
  assert.equal(generationConfig.responseMimeType, "application/json");
  const responseJsonSchema = generationConfig.responseJsonSchema as Record<
    string,
    unknown
  >;
  assert.equal(responseJsonSchema.type, "object");
  assert.deepEqual(responseJsonSchema.required, [
    "id",
    "version",
    "root",
    "capabilities",
  ]);
  const properties = responseJsonSchema.properties as Record<string, unknown>;
  assert.ok(properties.root);
  assert.ok(properties.capabilities);
  assert.ok(properties.source);
  const rootSchema = properties.root as Record<string, unknown>;
  assert.deepEqual(rootSchema.required, ["type"]);
  const rootProperties = rootSchema.properties as Record<string, unknown>;
  const rootType = rootProperties.type as Record<string, unknown>;
  assert.deepEqual(rootType.enum, ["text", "element", "component"]);
});

test("google interpreter retries structured request without schema when unsupported", async () => {
  const plan = {
    id: "google_retry_plan",
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
          value: "retry fallback",
        },
      ],
    },
  };

  const requests: Array<Record<string, unknown>> = [];
  let attempt = 0;

  const llm = new GoogleLLMInterpreter({
    apiKey: "google-key",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(parseBody(init?.body));
      attempt += 1;

      if (attempt === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "* GenerateContentRequest.generation_config.response_json_schema: unsupported by this model",
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      return jsonResponse({
        modelVersion: "gemini-2.5-flash",
        usageMetadata: {
          totalTokenCount: 18,
        },
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text: JSON.stringify(plan),
                },
              ],
            },
          },
        ],
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "retry structured runtime plan",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.deepEqual(response.value, plan);
  assert.equal(requests.length, 2);

  const firstGenerationConfig = requests[0].generationConfig as Record<
    string,
    unknown
  >;
  assert.equal(firstGenerationConfig.responseMimeType, "application/json");
  assert.ok("responseJsonSchema" in firstGenerationConfig);

  const secondGenerationConfig = requests[1].generationConfig as Record<
    string,
    unknown
  >;
  assert.equal(secondGenerationConfig.responseMimeType, "application/json");
  assert.equal(secondGenerationConfig.responseJsonSchema, undefined);
});

test("ollama interpreter generates text response", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OllamaLLMInterpreter({
    baseUrl: "https://example.ollama.test",
    model: "qwen2.5-coder:7b",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return jsonResponse({
        model: "qwen2.5-coder:7b",
        response: "ollama text response",
        prompt_eval_count: 5,
        eval_count: 8,
        done: true,
        done_reason: "stop",
      });
    },
  });

  const response = await llm.generateResponse({
    prompt: "build runtime card",
  });

  assert.equal(response.text, "ollama text response");
  assert.equal(response.model, "qwen2.5-coder:7b");
  assert.equal(response.tokensUsed, 13);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.ollama.test/api/generate");
  assert.equal(requests[0].body.model, "qwen2.5-coder:7b");
  assert.equal(requests[0].body.stream, false);
});

test("ollama interpreter preserves configured system prompts during fallback", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const llm = new OllamaLLMInterpreter({
    systemPrompt: "Keep configured safety constraints.",
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = parseBody(init?.body);
      return jsonResponse({
        model: "qwen2.5-coder:7b",
        response: "repaired runtime plan",
        done: true,
      });
    },
  });
  llm.setPromptTemplate("default", "Keep the default application context.");

  await llm.generateResponse({
    prompt: "repair the rejected response",
    systemPrompt: "Generate valid RuntimePlan JSON only.",
  });

  const prompt = requestBody?.prompt;
  assert.equal(typeof prompt, "string");
  assert.match(String(prompt), /Keep configured safety constraints\./);
  assert.match(String(prompt), /Keep the default application context\./);
  assert.match(String(prompt), /Generate valid RuntimePlan JSON only\./);
  assert.match(String(prompt), /repair the rejected response/);
});

test("ollama interpreter requests and validates native structured JSON", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const plan = {
    id: "ollama_runtime_plan_1",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "structured ollama plan" }],
    },
  };
  const llm = new OllamaLLMInterpreter({
    baseUrl: "https://example.ollama.test/",
    model: "qwen2.5-coder:7b",
    keepAlive: "5m",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });
      return jsonResponse({
        model: "qwen2.5-coder:7b",
        response: JSON.stringify(plan),
        prompt_eval_count: 9,
        eval_count: 12,
        done: true,
        done_reason: "stop",
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "build a runtime plan",
    context: { tenantId: "tenant-1" },
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.deepEqual(response.value, plan);
  assert.equal(response.tokensUsed, 21);
  assert.equal(response.model, "qwen2.5-coder:7b");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.ollama.test/api/generate");
  assert.equal(requests[0].body.model, "qwen2.5-coder:7b");
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.format, "json");
  assert.equal(requests[0].body.keep_alive, "5m");
  assert.match(String(requests[0].body.prompt), /tenant-1/);
  assert.match(String(requests[0].body.prompt), /No markdown/);
  assert.deepEqual(response.raw, {
    mode: "structured",
    format: "json",
    done: true,
    doneReason: "stop",
  });
});

test("ollama interpreter reports invalid structured payloads", async () => {
  const cases: Array<{
    response: string;
    error: RegExp;
    expectedValue?: unknown;
  }> = [
    {
      response: "",
      error: /Structured response content is empty/,
    },
    {
      response: "{not-json",
      error: /Structured JSON parse failed/,
    },
    {
      response: JSON.stringify({ type: "not-a-runtime-plan" }),
      error: /Structured payload is not a valid RuntimePlan/,
      expectedValue: { type: "not-a-runtime-plan" },
    },
  ];

  for (const testCase of cases) {
    let requestBody: Record<string, unknown> | undefined;
    const llm = new OllamaLLMInterpreter({
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = parseBody(init?.body);
        return jsonResponse({
          response: testCase.response,
          done: true,
        });
      },
    });

    const response = await llm.generateStructuredResponse({
      prompt: "build a runtime plan",
      format: "runtime-plan",
    });

    assert.equal(response.valid, false);
    assert.match(String(response.errors?.[0] ?? ""), testCase.error);
    assert.deepEqual(response.value, testCase.expectedValue);
    assert.equal(requestBody?.format, "json");
  }
});

test("ollama structured requests preserve reliability and error handling", async () => {
  const plan = {
    id: "ollama_retry_plan",
    version: 1,
    capabilities: { domWrite: true },
    root: { type: "text", value: "retried" },
  };
  let attempts = 0;
  const requestBodies: Record<string, unknown>[] = [];
  const llm = new OllamaLLMInterpreter({
    reliability: {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      retryJitterMs: 0,
    },
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      requestBodies.push(parseBody(init?.body));
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: "try again" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({
        response: JSON.stringify(plan),
        done: true,
      });
    },
  });

  const response = await llm.generateStructuredResponse({
    prompt: "retry a runtime plan",
    format: "runtime-plan",
  });

  assert.equal(response.valid, true);
  assert.deepEqual(response.value, plan);
  assert.equal(attempts, 2);
  assert.ok(requestBodies.every((body) => body.format === "json"));

  const failing = new OllamaLLMInterpreter({
    reliability: { maxRetries: 0 },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "invalid structured request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    () =>
      failing.generateStructuredResponse({
        prompt: "fail a runtime plan",
        format: "runtime-plan",
      }),
    /Ollama request failed \(400\): .*invalid structured request/,
  );
});

test("ollama structured request timeout aborts the native request", async () => {
  let aborted = false;
  const llm = new OllamaLLMInterpreter({
    timeoutMs: 20,
    reliability: { maxRetries: 0 },
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const onAbort = () => {
          aborted = true;
          reject(createAbortError());
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });

  await assert.rejects(
    () =>
      llm.generateStructuredResponse({
        prompt: "stall a runtime plan",
        format: "runtime-plan",
      }),
    /Ollama request timed out after 20ms/,
  );
  assert.equal(aborted, true);
});

test("ollama interpreter streams text response chunks", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = new OllamaLLMInterpreter({
    baseUrl: "https://example.ollama.test",
    model: "qwen2.5-coder:7b",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: parseBody(init?.body),
      });

      return ndjsonResponse([
        {
          model: "qwen2.5-coder:7b",
          response: "hello ",
          done: false,
        },
        {
          model: "qwen2.5-coder:7b",
          response: "ollama",
          done: false,
        },
        {
          model: "qwen2.5-coder:7b",
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 7,
        },
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream({
    prompt: "stream this",
  })) {
    chunks.push(chunk);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.ollama.test/api/generate");
  assert.equal(requests[0].body.stream, true);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].delta, "hello ");
  assert.equal(chunks[0].text, "hello ");
  assert.equal(chunks[1].delta, "ollama");
  assert.equal(chunks[1].text, "hello ollama");
  assert.equal(chunks[2].done, true);
  assert.equal(chunks[2].text, "hello ollama");
  assert.equal(chunks[2].tokensUsed, 17);
});

test("builtin llm stream providers cancel response bodies on early return", async (t) => {
  const cases: Array<{
    name: string;
    payload: string;
    create: (fetchImpl: typeof fetch) => LLMInterpreter;
  }> = [
    {
      name: "openai",
      payload: `data: ${JSON.stringify({
        model: "gpt-5-mini",
        choices: [{ delta: { content: "openai" } }],
      })}\n\n`,
      create: (fetchImpl) =>
        new OpenAILLMInterpreter({
          apiKey: "test-key",
          model: "gpt-5-mini",
          fetchImpl,
        }),
    },
    {
      name: "openai-codex",
      payload: `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "codex",
      })}\n\n`,
      create: (fetchImpl) =>
        new OpenAICodexLLMInterpreter({
          accessToken: "codex-test-token",
          model: "gpt-5.5",
          fetchImpl,
        }),
    },
    {
      name: "anthropic",
      payload: `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { text: "anthropic" },
      })}\n\n`,
      create: (fetchImpl) =>
        new AnthropicLLMInterpreter({
          apiKey: "anthropic-key",
          model: "claude-sonnet-4-5",
          fetchImpl,
        }),
    },
    {
      name: "google",
      payload: `data: ${JSON.stringify({
        modelVersion: "gemini-2.5-flash",
        candidates: [{ content: { parts: [{ text: "google" }] } }],
      })}\n\n`,
      create: (fetchImpl) =>
        new GoogleLLMInterpreter({
          apiKey: "google-key",
          model: "gemini-2.5-flash",
          fetchImpl,
        }),
    },
    {
      name: "ollama",
      payload: `${JSON.stringify({
        model: "qwen2.5-coder:7b",
        response: "ollama",
        done: false,
      })}\n`,
      create: (fetchImpl) =>
        new OllamaLLMInterpreter({
          model: "qwen2.5-coder:7b",
          fetchImpl,
        }),
    },
    {
      name: "lmstudio",
      payload: `data: ${JSON.stringify({
        model: "qwen2.5-coder-7b-instruct",
        choices: [{ delta: { content: "lmstudio" } }],
      })}\n\n`,
      create: (fetchImpl) =>
        new LMStudioLLMInterpreter({
          model: "qwen2.5-coder-7b-instruct",
          fetchImpl,
        }),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let bodyCanceled = false;
      const encoder = new TextEncoder();
      const fetchImpl = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(testCase.payload));
            },
            cancel() {
              bodyCanceled = true;
            },
          }),
          { status: 200 },
        );
      const llm = testCase.create(fetchImpl);
      const responseStream = llm.generateResponseStream?.({
        prompt: "stop early",
      });
      assert.ok(responseStream);

      const iterator = responseStream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.ok(first.value.delta.length > 0);

      await iterator.return?.();

      assert.equal(bodyCanceled, true);
    });
  }
});

test("llm provider registry can create builtin openai interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "openai",
    providerOptions: {
      apiKey: "test-key",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          id: "chatcmpl_provider_openai",
          model: "gpt-5-mini",
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

test("llm provider registry can create builtin openai codex interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "openai-codex",
    providerOptions: {
      accessToken: "codex-test-token",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        sseResponse([
          "event: response.completed\ndata: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_provider_codex",
                model: "gpt-5.5",
                output_text: "ok-codex",
              },
            }),
        ]),
    },
  });

  assert.ok(llm instanceof OpenAICodexLLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });
  assert.equal(response.text, "ok-codex");
});

test("llm provider registry can create builtin anthropic interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "anthropic",
    providerOptions: {
      apiKey: "anthropic-key",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          id: "msg_provider_anthropic",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok-anthropic" }],
        }),
    },
  });

  assert.ok(llm instanceof AnthropicLLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });
  assert.equal(response.text, "ok-anthropic");
});

test("llm provider registry can create builtin google interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "google",
    providerOptions: {
      apiKey: "google-key",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: "ok-google",
                  },
                ],
              },
            },
          ],
        }),
    },
  });

  assert.ok(llm instanceof GoogleLLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });
  assert.equal(response.text, "ok-google");
});

test("llm provider registry can create builtin ollama interpreter", async () => {
  const llm = createLLMInterpreter({
    provider: "ollama",
    providerOptions: {
      baseUrl: "https://example.ollama.test",
      fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          model: "qwen2.5-coder:7b",
          response: "ok-ollama",
          done: true,
        }),
    },
  });

  assert.ok(llm instanceof OllamaLLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });
  assert.equal(response.text, "ok-ollama");
});

test("llm provider registry can create builtin lmstudio interpreter", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const llm = createLLMInterpreter({
    provider: "lmstudio",
    providerOptions: {
      baseUrl: "https://example.lmstudio.test/v1",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: parseBody(init?.body),
        });

        return jsonResponse({
          id: "chatcmpl_provider_lmstudio",
          model: "qwen2.5-coder-7b-instruct",
          choices: [{ message: { content: "ok-lmstudio" } }],
        });
      },
    },
  });

  assert.ok(llm instanceof LMStudioLLMInterpreter);
  const response = await llm.generateResponse({
    prompt: "test provider",
  });

  assert.equal(response.text, "ok-lmstudio");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.lmstudio.test/v1/chat/completions",
  );
});

test("lmstudio configure accepts generic Renderify LLM option names", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const llm = new LMStudioLLMInterpreter({
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      });
      return jsonResponse({
        choices: [{ message: { content: "configured" } }],
      });
    },
  });
  llm.configure({
    llmApiKey: "local-secret",
    llmBaseUrl: "https://configured.lmstudio.test/v1/",
    llmModel: "configured-local-model",
  });

  const response = await llm.generateResponse({ prompt: "configure aliases" });

  assert.equal(response.text, "configured");
  assert.equal(
    requests[0]?.url,
    "https://configured.lmstudio.test/v1/chat/completions",
  );
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer local-secret",
  );
  assert.equal(requests[0]?.body.model, "configured-local-model");
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

function ndjsonResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
      },
    },
  );
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

function assertCodexInputText(input: unknown): string {
  assert.ok(Array.isArray(input), "Codex input must be an item list");
  assert.equal(input.length, 1);

  const message = input[0] as Record<string, unknown>;
  assert.equal(message.type, "message");
  assert.equal(message.role, "user");
  assert.ok(Array.isArray(message.content), "Codex message content list");
  assert.equal(message.content.length, 1);

  const part = message.content[0] as Record<string, unknown>;
  assert.equal(part.type, "input_text");
  const text = part.text;
  if (typeof text !== "string") {
    assert.fail("Codex input text must be a string");
  }
  return text;
}

function codexAccessToken(accountId: string): string {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const payload = base64UrlEncode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
  return `${header}.${payload}.signature`;
}

function base64UrlEncode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createAbortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}
