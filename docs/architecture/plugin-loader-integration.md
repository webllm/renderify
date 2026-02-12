# Plugin And Loader Integration Guide

## Goal

This guide shows how to extend Renderify without forking core runtime:

- add pipeline plugins
- replace module loader (JSPM is default)
- apply custom security policy profiles
- plug in strict structured-output LLM adapters

## 1. Register Plugins

Plugins run through hook stages in `@renderify/core`.

```ts
import { DefaultCustomizationEngine } from "@renderify/core";

const customization = new DefaultCustomizationEngine();

customization.registerPlugin({
  name: "trace-logger",
  hooks: {
    beforeRuntime(payload, context) {
      console.log("[beforeRuntime]", context.traceId);
      return payload;
    },
    afterRuntime(payload, context) {
      console.log("[afterRuntime]", context.traceId, payload.diagnostics.length);
      return payload;
    },
  },
});
```

Available hooks:

- `beforeLLM`
- `afterLLM`
- `beforeCodeGen`
- `afterCodeGen`
- `beforePolicyCheck`
- `afterPolicyCheck`
- `beforeRuntime`
- `afterRuntime`
- `beforeRender`
- `afterRender`

## 2. Replace Module Loader

Runtime depends on `RuntimeModuleLoader` interface.

```ts
interface RuntimeModuleLoader {
  load(specifier: string): Promise<unknown>;
  unload?(specifier: string): Promise<void>;
}
```

Default:

- `@renderify/runtime` (`JspmModuleLoader`)

Custom loader example:

```ts
class InMemoryLoader {
  constructor(private modules: Record<string, unknown>) {}

  async load(specifier: string): Promise<unknown> {
    if (!(specifier in this.modules)) {
      throw new Error("missing module: " + specifier);
    }
    return this.modules[specifier];
  }
}
```

Inject into runtime:

```ts
import { DefaultRuntimeManager } from "@renderify/runtime";

const runtime = new DefaultRuntimeManager({
  moduleLoader: new InMemoryLoader({
    "npm:acme/widget": {
      default: () => ({ type: "text", value: "hi" }),
    },
  }),
});
```

For TSX/JSX runtime source modules, the loader resolver is used to rewrite bare
import specifiers to executable URLs. `@renderify/runtime` provides this behavior.

For production determinism, include `moduleManifest` in `RuntimePlan` and map each
bare specifier to a pinned `resolvedUrl` (and optionally `integrity`).

## 3. Apply Security Policy Profiles

Configure policy through `RenderifyConfig` key `securityPolicy`.

```ts
config.set("securityPolicy", {
  blockedTags: ["script", "iframe"],
  maxTreeDepth: 8,
  maxNodeCount: 300,
  allowInlineEventHandlers: false,
  allowedModules: ["npm:", "/"],
  allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
  allowArbitraryNetwork: false,
  maxAllowedImports: 100,
  maxAllowedExecutionMs: 5000,
  maxAllowedComponentInvocations: 200,
});
```

Select profile baseline through config/env:

```ts
config.set("securityProfile", "strict");
```

Environment:

```bash
RENDERIFY_SECURITY_PROFILE=strict
```

## 4. Runtime Isolation Notes

To enable VM-isolated component execution for compatible sync components:

```json
{
  "capabilities": {
    "executionProfile": "isolated-vm"
  }
}
```

## 5. Recommended Extension Strategy

1. Keep IR stable and small.
2. Extend via hooks before modifying core orchestration.
3. Add policy checks before enabling new runtime capabilities.
4. Add unit tests for each plugin/loader customization path.

## 6. LLM Structured Adapter Notes

`RenderifyApp.renderPrompt` now prefers structured `runtime-plan` output when the
interpreter exposes `generateStructuredResponse`.

Adapter contract shape:

```ts
interface LLMStructuredRequest extends LLMRequest {
  format: "runtime-plan";
  strict?: boolean;
}

interface LLMStructuredResponse<T = unknown> {
  text: string;
  value?: T;
  valid: boolean;
  errors?: string[];
}
```

Fallback semantics:

1. try structured response
2. if `valid=false`, fallback to `generateResponse` text path

You can disable structured-first mode by setting:

```bash
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=false
```

When structured mode is disabled, you can return fenced `tsx/jsx/ts/js` blocks.
`@renderify/core` will convert those blocks into `plan.source` and runtime will
execute them through Babel + JSPM resolution.

OpenAI provider quick setup:

```ts
import { createLLMInterpreter } from "@renderify/llm";

const llm = createLLMInterpreter({
  provider: "openai",
  providerOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
    model: process.env.RENDERIFY_LLM_MODEL ?? "gpt-4.1-mini",
    baseUrl:
      process.env.RENDERIFY_LLM_BASE_URL ?? "https://api.openai.com/v1",
  },
});
```

Anthropic provider quick setup:

```ts
import { createLLMInterpreter } from "@renderify/llm";

const llm = createLLMInterpreter({
  provider: "anthropic",
  providerOptions: {
    apiKey: process.env.RENDERIFY_LLM_API_KEY,
    model: process.env.RENDERIFY_LLM_MODEL ?? "claude-3-5-sonnet-latest",
    baseUrl:
      process.env.RENDERIFY_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
  },
});
```

CLI/provider env:

```bash
RENDERIFY_LLM_PROVIDER=openai
RENDERIFY_LLM_API_KEY=<your_key>
RENDERIFY_LLM_MODEL=gpt-4.1-mini
RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1
RENDERIFY_LLM_TIMEOUT_MS=30000
```

Runtime protocol/runtime safety env:

```bash
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true
RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK=false
RENDERIFY_RUNTIME_SPEC_VERSIONS=runtime-plan/v1
```
