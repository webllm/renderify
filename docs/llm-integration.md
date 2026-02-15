# LLM Integration

Renderify supports multiple LLM providers for generating UI from natural language prompts. The LLM layer handles text generation, streaming, and structured (JSON schema) output.

## Supported Providers

| Provider        | Default Model              | Package          |
| --------------- | -------------------------- | ---------------- |
| OpenAI          | `gpt-5-mini`             | `@renderify/llm` |
| Anthropic       | `claude-sonnet-4-5` | `@renderify/llm` |
| Google (Gemini) | `gemini-2.5-flash`         | `@renderify/llm` |

## Configuration

### Environment Variables

```bash
# Provider selection
RENDERIFY_LLM_PROVIDER=openai|anthropic|google

# API credentials
RENDERIFY_LLM_API_KEY=your-api-key

# Optional: custom model
RENDERIFY_LLM_MODEL=gpt-5-mini

# Optional: custom base URL (for proxies or self-hosted)
RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1

# Optional: request timeout
RENDERIFY_LLM_TIMEOUT_MS=30000

# Optional: structured output preference
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=true|false
```

### Programmatic Configuration

```ts
import { createLLMInterpreter } from "@renderify/llm";

// OpenAI
const openai = createLLMInterpreter({
  provider: "openai",
  providerOptions: {
    apiKey: "sk-...",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    timeoutMs: 30000,
  },
});

// Anthropic
const anthropic = createLLMInterpreter({
  provider: "anthropic",
  providerOptions: {
    apiKey: "sk-ant-...",
    model: "claude-sonnet-4-5",
    maxTokens: 4096,
  },
});

// Google
const google = createLLMInterpreter({
  provider: "google",
  providerOptions: {
    apiKey: "...",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
});
```

## Generation Modes

### 1. Structured Output (Preferred)

When `RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=true` (default), the pipeline requests a RuntimePlan JSON directly from the LLM using JSON schema constraints.

```ts
const structuredRequest = {
  prompt: "Build a dashboard",
  format: "runtime-plan",
  strict: true,
};

const response = await llm.generateStructuredResponse(structuredRequest);
// response.value is a parsed RuntimePlan JSON
// response.valid indicates if the JSON conforms to the schema
```

The JSON schema enforces:

- Required fields: `id`, `version`, `root`, `capabilities`
- Node type constraints: `text` (with `value`), `element` (with `tag`), `component` (with `module`)
- Capability field types and ranges
- State model structure

### 2. Text Generation (Fallback)

If structured output fails or is disabled, the LLM generates free-form text. The code generator then attempts to extract a RuntimePlan:

1. Look for a complete RuntimePlan JSON in the text
2. Extract fenced code blocks (`tsx, `jsx, etc.)
3. Fall back to wrapping the text as a text node

```bash
# Force text generation mode
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false pnpm playground
```

### 3. Streaming Generation

All providers support streaming via server-sent events (SSE). The pipeline emits incremental tokens:

```ts
for await (const chunk of llm.generateResponseStream(request)) {
  console.log(chunk.delta); // New token
  console.log(chunk.text); // Accumulated text so far
  console.log(chunk.done); // Is this the final chunk?
}
```

During streaming, the codegen stage processes deltas incrementally, enabling progressive UI preview.

## LLM Interpreter Interface

```ts
interface LLMInterpreter {
  configure(options: Record<string, unknown>): void;

  generateResponse(request: LLMRequest): Promise<LLMResponse>;

  generateResponseStream?(
    request: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk>;

  generateStructuredResponse?(
    request: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<unknown>>;

  setPromptTemplate(name: string, template: string): void;
  getPromptTemplate(name: string): string | undefined;
}
```

### Request Types

```ts
interface LLMRequest {
  prompt: string;
  context?: Record<string, unknown>;
  systemPrompt?: string;
  signal?: AbortSignal;
}

interface LLMStructuredRequest extends LLMRequest {
  format: "runtime-plan";
  strict?: boolean;
}
```

### Response Types

```ts
interface LLMResponse {
  text: string;
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

interface LLMResponseStreamChunk {
  delta: string; // New content since last chunk
  text: string; // Full accumulated text
  done: boolean; // Is this the final chunk?
  index: number; // Chunk sequence number
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

interface LLMStructuredResponse<T> {
  value?: T; // Parsed structured value
  text: string; // Raw text representation
  valid: boolean; // Whether the value conforms to the schema
  errors?: string[]; // Validation errors
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}
```

## Provider Registry

The provider registry supports dynamic registration of custom providers:

```ts
import {
  LLMProviderRegistry,
  createDefaultLLMProviderRegistry,
} from "@renderify/llm";

// Use the default registry with all built-in providers
const registry = createDefaultLLMProviderRegistry();

// Register a custom provider
registry.register({
  name: "my-provider",
  create(options) {
    return new MyCustomLLMInterpreter(options);
  },
});

// Create an interpreter instance
const llm = registry.create("my-provider", { apiKey: "..." });
```

## Abort Support

All LLM operations accept an `AbortSignal` for cancellation:

```ts
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

const result = await app.renderPrompt("Build a dashboard", {
  signal: controller.signal,
});
```

## Prompt Templates

Providers support configurable prompt templates:

```ts
llm.setPromptTemplate?.(
  "system",
  `
  You are a UI generator. Generate a RuntimePlan JSON for the user's request.
  Always include specVersion: "runtime-plan/v1".
`,
);

const template = llm.getPromptTemplate?.("system");
```

## Structured Output Fallback Flow

````
1. Request structured RuntimePlan JSON from LLM
   │
   ├── Valid JSON returned → Use directly
   │
   └── Invalid/empty → Fallback to text generation
                          │
                          ├── Text contains RuntimePlan JSON → Parse it
                          ├── Text contains ```tsx block → Extract source module
                          └── Plain text → Wrap as text node
````

This dual-path approach maximizes compatibility across different LLM models while preferring the most precise output format.

## Error Handling

The LLM layer handles several error scenarios:

- **API errors** — HTTP error responses with status codes
- **Refusals** — model-level content refusals (safety filters)
- **Timeouts** — configurable per-provider request timeouts
- **Abort signals** — immediate cancellation via AbortController
- **Malformed responses** — invalid JSON or missing required fields
- **Rate limiting** — provider-specific error handling
