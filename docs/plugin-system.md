# Plugin System

Renderify provides a hook-based plugin architecture that lets you intercept and transform data at every stage of the rendering pipeline. Plugins run without forking the core — they compose naturally with the built-in processing.

## Hook Points

The pipeline exposes 10 hook points organized as before/after pairs around each stage:

```
beforeLLM ──▶ [LLM Generation] ──▶ afterLLM
  ──▶ beforeCodeGen ──▶ [Code Generation] ──▶ afterCodeGen
     ──▶ beforePolicyCheck ──▶ [Security Check] ──▶ afterPolicyCheck
        ──▶ beforeRuntime ──▶ [Runtime Execution] ──▶ afterRuntime
           ──▶ beforeRender ──▶ [UI Rendering] ──▶ afterRender
```

| Hook                | Input Type               | Output Type              | Description                     |
| ------------------- | ------------------------ | ------------------------ | ------------------------------- |
| `beforeLLM`         | `string`                 | `string`                 | Transform the prompt before LLM |
| `afterLLM`          | `LLMResponse`            | `LLMResponse`            | Transform LLM response          |
| `beforeCodeGen`     | `CodeGenerationInput`    | `CodeGenerationInput`    | Transform codegen input         |
| `afterCodeGen`      | `RuntimePlan`            | `RuntimePlan`            | Transform generated plan        |
| `beforePolicyCheck` | `RuntimePlan`            | `RuntimePlan`            | Transform plan before security  |
| `afterPolicyCheck`  | `SecurityCheckResult`    | `SecurityCheckResult`    | Transform security result       |
| `beforeRuntime`     | `RuntimeExecutionInput`  | `RuntimeExecutionInput`  | Transform runtime input         |
| `afterRuntime`      | `RuntimeExecutionResult` | `RuntimeExecutionResult` | Transform execution result      |
| `beforeRender`      | `RuntimeExecutionResult` | `RuntimeExecutionResult` | Transform before rendering      |
| `afterRender`       | `string`                 | `string`                 | Transform rendered HTML         |

## Creating a Plugin

```ts
import type { RenderifyPlugin } from "@renderify/core";

const myPlugin: RenderifyPlugin = {
  name: "my-plugin",
  hooks: {
    beforeLLM: async (prompt, context) => {
      // Prepend system context to every prompt
      return `[User: ${context.traceId}] ${prompt}`;
    },

    afterCodeGen: async (plan, context) => {
      // Add metadata to every generated plan
      return {
        ...plan,
        metadata: {
          ...plan.metadata,
          processedBy: "my-plugin",
          traceId: context.traceId,
        },
      };
    },

    afterRender: async (html, context) => {
      // Wrap rendered HTML in a container
      return `<div class="my-wrapper">${html}</div>`;
    },
  },
};
```

## Registering Plugins

```ts
import {
  createRenderifyApp,
  DefaultCustomizationEngine,
  // ... other imports
} from "@renderify/core";

const customization = new DefaultCustomizationEngine();
customization.registerPlugin(myPlugin);
customization.registerPlugin(anotherPlugin);

const app = createRenderifyApp({
  // ... other dependencies
  customization,
});
```

## Plugin Context

Every hook handler receives a `PluginContext` with:

```ts
interface PluginContext {
  traceId: string; // Unique identifier for the current render
  hookName: PluginHook; // Which hook is being called
}
```

## Plugin Handler Signature

```ts
type PluginHandler = (
  payload: unknown,
  context: PluginContext,
) => Promise<unknown>;
```

Each handler receives the current payload and must return the (possibly transformed) payload. The return value is passed to the next plugin's handler for the same hook, then to the pipeline stage.

## Execution Order

When multiple plugins register handlers for the same hook, they execute in registration order:

```ts
const pluginA: RenderifyPlugin = {
  name: "plugin-a",
  hooks: {
    beforeLLM: async (prompt) => prompt + " [A]",
  },
};

const pluginB: RenderifyPlugin = {
  name: "plugin-b",
  hooks: {
    beforeLLM: async (prompt) => prompt + " [B]",
  },
};

customization.registerPlugin(pluginA);
customization.registerPlugin(pluginB);

// Input: "Hello" → Plugin A: "Hello [A]" → Plugin B: "Hello [A] [B]"
```

## Use Cases

### Prompt Enhancement

Add context, constraints, or formatting instructions before the LLM:

```ts
const promptEnhancer: RenderifyPlugin = {
  name: "prompt-enhancer",
  hooks: {
    beforeLLM: async (prompt) => {
      return `${prompt}\n\nRequirements:\n- Use Preact hooks\n- Include error handling\n- Add loading states`;
    },
  },
};
```

### Plan Validation

Add custom validation beyond the built-in security checks:

```ts
const planValidator: RenderifyPlugin = {
  name: "plan-validator",
  hooks: {
    afterCodeGen: async (plan) => {
      if (plan.source && plan.source.code.includes("console.log")) {
        // Strip console.log from production plans
        return {
          ...plan,
          source: {
            ...plan.source,
            code: plan.source.code.replace(/console\.log\([^)]*\);?/g, ""),
          },
        };
      }
      return plan;
    },
  },
};
```

### Logging & Telemetry

Track pipeline execution without modifying the data:

```ts
const telemetry: RenderifyPlugin = {
  name: "telemetry",
  hooks: {
    beforeLLM: async (prompt, ctx) => {
      console.log(`[${ctx.traceId}] LLM start: ${prompt.slice(0, 50)}...`);
      return prompt;
    },
    afterRender: async (html, ctx) => {
      console.log(`[${ctx.traceId}] Render complete: ${html.length} bytes`);
      return html;
    },
  },
};
```

### Security Augmentation

Add custom security policies:

```ts
const securityAugmenter: RenderifyPlugin = {
  name: "security-augmenter",
  hooks: {
    afterPolicyCheck: async (result) => {
      // Add custom check
      if (result.safe && someCustomCheck()) {
        return {
          ...result,
          safe: false,
          issues: [...result.issues, "Custom policy violation"],
        };
      }
      return result;
    },
  },
};
```

### HTML Post-Processing

Transform the final rendered HTML:

```ts
const htmlPostProcessor: RenderifyPlugin = {
  name: "html-post-processor",
  hooks: {
    afterRender: async (html) => {
      // Add analytics script, wrapper divs, custom styles, etc.
      return `<div class="renderify-output" data-rendered="${Date.now()}">${html}</div>`;
    },
  },
};
```

## CustomizationEngine API

```ts
interface CustomizationEngine {
  registerPlugin(plugin: RenderifyPlugin): void;
  getPlugins(): RenderifyPlugin[];
  runHook<Payload>(
    hookName: PluginHook,
    payload: Payload,
    context: PluginContext,
  ): Promise<Payload>;
}
```

### Plugin Interface

```ts
interface RenderifyPlugin {
  name: string;
  hooks: Partial<Record<PluginHook, PluginHandler>>;
}

type PluginHook =
  | "beforeLLM"
  | "afterLLM"
  | "beforeCodeGen"
  | "afterCodeGen"
  | "beforePolicyCheck"
  | "afterPolicyCheck"
  | "beforeRuntime"
  | "afterRuntime"
  | "beforeRender"
  | "afterRender";
```

## Notes

- Hooks are **async** — handlers can perform async operations (API calls, file reads, etc.)
- Hooks are **composable** — multiple plugins chain naturally
- Hooks are **transparent** — if no plugins are registered, the pipeline runs unmodified
- Plugin names are identifiers only; uniqueness is recommended but currently not enforced by the engine
- If a hook handler throws, the error propagates and stops the pipeline
