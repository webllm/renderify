# @renderify/llm

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/llm.svg)
![license](https://img.shields.io/npm/l/@renderify/llm)

LLM provider implementations and registry for Renderify.

`@renderify/llm` provides built-in interpreters for OpenAI, OpenAI Codex, Anthropic, Google, Ollama, and LM Studio, plus a provider registry API for custom providers.

## Install

```bash
pnpm add @renderify/llm
# or
npm i @renderify/llm
```

## Built-in Providers

- `OpenAILLMInterpreter` (`provider: "openai"`)
- `OpenAICodexLLMInterpreter` (`provider: "openai-codex"`)
- `AnthropicLLMInterpreter` (`provider: "anthropic"`)
- `GoogleLLMInterpreter` (`provider: "google"`)
- `OllamaLLMInterpreter` (`provider: "ollama"`)
- `LMStudioLLMInterpreter` (`provider: "lmstudio"`)

## Factory API

- `createLLMInterpreter({ provider, providerOptions })`
- `LLMProviderRegistry`
- `createDefaultLLMProviderRegistry()`

## Quick Start

```ts
import { createLLMInterpreter } from "@renderify/llm";

const llm = createLLMInterpreter({
  provider: "openai",
  providerOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
    model: "gpt-4o-mini",
  },
});

const response = await llm.generateResponse({
  prompt: "return a simple RuntimePlan JSON",
  context: {},
});

console.log(response.text);
```

## OpenAI Codex

The OpenAI Codex provider talks directly to the Codex Responses backend. The provider accepts an OAuth access token; CLI users should normally create and refresh that token with `renderify auth codex login`.

```ts
import { createLLMInterpreter } from "@renderify/llm";

const codex = createLLMInterpreter({
  provider: "openai-codex",
  providerOptions: {
    accessToken: process.env.RENDERIFY_CODEX_ACCESS_TOKEN,
    model: "gpt-5.3-codex-spark",
    // Spark defaults to low reasoning for latency-sensitive rendering.
    reasoningEffort: "low",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  },
});
```

Set `reasoningEffort` to `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
or `max` to override the provider default when the selected model supports that
level. Renderify uses `low` automatically for `gpt-5.3-codex-spark`; other
models keep the backend default when omitted. Spark rejects unsupported levels
locally before a network request is sent.

## Local Models Example

```ts
import { createLLMInterpreter } from "@renderify/llm";

const ollama = createLLMInterpreter({
  provider: "ollama",
  providerOptions: {
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:7b",
  },
});

const lmstudio = createLLMInterpreter({
  provider: "lmstudio",
  providerOptions: {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-coder-7b-instruct",
  },
});
```

## Reliability Controls

Each provider supports request reliability options through `providerOptions.reliability`:

```ts
const llm = createLLMInterpreter({
  provider: "openai",
  providerOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
    reliability: {
      maxRetries: 2,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 2000,
      retryJitterMs: 50,
      retryStatusCodes: [408, 429, 500, 502, 503, 504],
      retryOnNetworkError: true,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerCooldownMs: 15000,
    },
  },
});
```

Defaults include bounded retry/backoff and circuit breaking for repeated upstream failures.

## Custom Provider

```ts
import { LLMProviderRegistry, createLLMInterpreter } from "@renderify/llm";

const registry = new LLMProviderRegistry();
registry.register({
  name: "my-provider",
  create: () => {
    const templates = new Map();
    return {
      configure() {},
      async generateResponse() {
        return { text: "{}", tokensUsed: 0 };
      },
      setPromptTemplate(name, content) {
        templates.set(name, content);
      },
      getPromptTemplate(name) {
        return templates.get(name);
      },
    };
  },
});

const llm = createLLMInterpreter({ provider: "my-provider", registry });
```

## Notes

- Provider implementations follow the `LLMInterpreter` interface from `@renderify/core`.
- Streaming support is available through `generateResponseStream()` when provided by the selected interpreter.
