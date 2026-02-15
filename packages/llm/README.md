# @renderify/llm

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/llm.svg)
![license](https://img.shields.io/npm/l/@renderify/llm)

LLM provider implementations and registry for Renderify.

`@renderify/llm` provides built-in interpreters for OpenAI, Anthropic, Google, Ollama, and LM Studio, plus a provider registry API for custom providers.

## Install

```bash
pnpm add @renderify/llm
# or
npm i @renderify/llm
```

## Built-in Providers

- `OpenAILLMInterpreter` (`provider: "openai"`)
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
