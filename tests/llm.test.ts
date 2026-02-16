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
  OpenAILLMInterpreter,
} from "../packages/llm/src/index";

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
  assert.equal(responseFormat.json_schema?.strict, true);
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
    fetchImpl: async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
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
      }),
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

function createAbortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}
