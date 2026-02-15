# @renderify/llm

LLM provider implementations and registry for Renderify.

`@renderify/llm` provides built-in interpreters for OpenAI, Anthropic, and Google, plus a provider registry API for custom providers.

## Install

```bash
pnpm add @renderify/llm
# or
npm i @renderify/llm
```

## Built-in Providers

- `OpenAILLMInterpreter`
- `AnthropicLLMInterpreter`
- `GoogleLLMInterpreter`

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
