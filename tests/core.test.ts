import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/core/src/codegen";
import {
  DefaultRenderifyConfig,
  type RenderifyConfigValues,
} from "../packages/core/src/config";
import {
  createRenderifyApp,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  PolicyRejectionError,
  type RenderifyCoreDependencies,
} from "../packages/core/src/index";
import type {
  LLMInterpreter,
  LLMRequest,
  LLMResponse,
  LLMResponseStreamChunk,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "../packages/core/src/llm-interpreter";
import { DefaultUIRenderer } from "../packages/core/src/ui";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import { DefaultRuntimeManager } from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";

class RejectingConfig extends DefaultRenderifyConfig {
  async load(overrides?: Partial<RenderifyConfigValues>): Promise<void> {
    await super.load(overrides);
    this.set("securityPolicy", {
      blockedTags: ["section"],
      maxTreeDepth: 12,
      maxNodeCount: 500,
      allowInlineEventHandlers: false,
      allowedModules: ["/", "npm:"],
      allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
      allowArbitraryNetwork: false,
    });
  }
}

class StructuredOnlyLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(_req: LLMRequest): Promise<LLMResponse> {
    return {
      text: "fallback text should not be used",
      model: "structured-only",
      raw: { mode: "text" },
    };
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    const plan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "structured_core_plan",
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
            value: `Structured: ${req.prompt}`,
          },
        ],
      },
    };

    return {
      text: JSON.stringify(plan),
      value: plan as T,
      valid: true,
      model: "structured-only",
      raw: {
        mode: "structured",
      },
    };
  }

  setPromptTemplate(_templateName: string, _templateContent: string): void {}

  getPromptTemplate(_templateName: string): string | undefined {
    return undefined;
  }
}

class InvalidStructuredLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: `text fallback: ${req.prompt}`,
      model: "invalid-structured",
      raw: { mode: "text" },
    };
  }

  async generateStructuredResponse<T = unknown>(
    _req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    return {
      text: '{"invalid":true}',
      valid: false,
      errors: ["invalid schema"],
      model: "invalid-structured",
    };
  }

  setPromptTemplate(_templateName: string, _templateContent: string): void {}

  getPromptTemplate(_templateName: string): string | undefined {
    return undefined;
  }
}

class DemoLLMInterpreter implements LLMInterpreter {
  private config: Record<string, unknown> = {};

  configure(options: Record<string, unknown>): void {
    this.config = { ...this.config, ...options };
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const text = `Generated runtime description for: ${req.prompt}`;
    return {
      text,
      model: String(this.config.model ?? "demo-llm"),
      tokensUsed: text.length,
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const full = await this.generateResponse(req);
    const midpoint = Math.max(1, Math.floor(full.text.length / 2));
    const firstDelta = full.text.slice(0, midpoint);
    const secondDelta = full.text.slice(midpoint);

    yield {
      delta: firstDelta,
      text: firstDelta,
      done: false,
      index: 1,
      tokensUsed: full.tokensUsed,
      model: full.model,
    };
    yield {
      delta: secondDelta,
      text: full.text,
      done: true,
      index: 2,
      tokensUsed: full.tokensUsed,
      model: full.model,
    };
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    const value = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: `demo_plan_${Date.now().toString(36)}`,
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "section",
        children: [{ type: "text", value: req.prompt }],
      },
    };

    return {
      text: JSON.stringify(value),
      value: value as T,
      valid: true,
      model: String(this.config.model ?? "demo-llm"),
    };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

class StreamingFailureLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: req.prompt,
      model: "stream-failure-llm",
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    yield {
      delta: req.prompt.slice(0, 4),
      text: req.prompt.slice(0, 4),
      done: false,
      index: 1,
      model: "stream-failure-llm",
    };

    throw new Error("stream exploded");
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

class CountingIncrementalCodeGenerator extends DefaultCodeGenerator {
  public generatePlanCalls = 0;
  public pushDeltaCalls = 0;
  public finalizeCalls = 0;

  override async generatePlan(input: {
    prompt: string;
    llmText: string;
    context?: Record<string, unknown>;
  }) {
    this.generatePlanCalls += 1;
    return super.generatePlan(input);
  }

  override createIncrementalSession(input: {
    prompt: string;
    context?: Record<string, unknown>;
  }) {
    const base = super.createIncrementalSession(input);

    return {
      pushDelta: async (delta: string) => {
        this.pushDeltaCalls += 1;
        return base.pushDelta(delta);
      },
      finalize: async (finalText?: string) => {
        this.finalizeCalls += 1;
        return base.finalize(finalText);
      },
    };
  }
}

function createDependencies(
  overrides: Partial<RenderifyCoreDependencies> = {},
): RenderifyCoreDependencies {
  return {
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new DemoLLMInterpreter(),
    codegen: new DefaultCodeGenerator(),
    runtime: new DefaultRuntimeManager(),
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
    ...overrides,
  };
}

test("core renderPrompt returns plan/html with diagnostics", async () => {
  const app = createRenderifyApp(createDependencies());

  await app.start();

  const result = await app.renderPrompt("Build runtime welcome");
  assert.ok(result.traceId.startsWith("trace_"));
  assert.ok(result.plan.id.length > 0);
  assert.match(result.html, /Build runtime welcome/);
  assert.ok(Array.isArray(result.execution.diagnostics));

  await app.stop();
});

test("core rejects blocked plan with policy rejection error", async () => {
  const app = createRenderifyApp(
    createDependencies({
      config: new RejectingConfig(),
    }),
  );

  await app.start();

  await assert.rejects(
    () => app.renderPrompt("This should be rejected"),
    (error: unknown) => {
      return error instanceof PolicyRejectionError;
    },
  );

  await app.stop();
});

test("core renderPlan executes provided plan", async () => {
  const app = createRenderifyApp(createDependencies());

  await app.start();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_render_plan",
    version: 1,
    root: createElementNode("section", undefined, [
      createTextNode("Hello from render plan"),
    ]),
    capabilities: {
      domWrite: true,
    },
  };

  const result = await app.renderPlan(plan, { prompt: "plan mode" });
  assert.match(result.html, /Hello from render plan/);
  assert.equal(result.plan.id, "core_render_plan");

  await app.stop();
});

test("core prefers structured llm output when available", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new StructuredOnlyLLM(),
    }),
  );

  await app.start();

  const result = await app.renderPrompt("use structured");
  assert.match(result.html, /Structured: use structured/);
  const raw = result.llm.raw as { mode?: string } | undefined;
  assert.equal(raw?.mode, "structured");

  await app.stop();
});

test("core falls back to text generation when structured output is invalid", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new InvalidStructuredLLM(),
    }),
  );

  await app.start();

  const result = await app.renderPrompt("fallback");
  assert.match(result.html, /text fallback: fallback/);
  const raw = result.llm.raw as { mode?: string } | undefined;
  assert.equal(raw?.mode, "fallback-text");

  await app.stop();
});

test("core renderPromptStream emits incremental chunks and final result", async () => {
  const app = createRenderifyApp(createDependencies());
  await app.start();

  const chunks = [];
  let finalHtml = "";

  for await (const chunk of app.renderPromptStream(
    "Build runtime stream view",
    {
      previewEveryChunks: 1,
    },
  )) {
    chunks.push(chunk.type);
    if (chunk.type === "final" && chunk.final) {
      finalHtml = chunk.final.html;
    }
  }

  assert.ok(chunks.includes("llm-delta"));
  assert.ok(chunks.includes("preview"));
  assert.ok(chunks.includes("final"));
  assert.ok(finalHtml.length > 0);

  await app.stop();
});

test("core renderPromptStream prefers structured output when available", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new StructuredOnlyLLM(),
    }),
  );

  await app.start();

  const seen = new Set<string>();
  let finalHtml = "";
  let llmMode = "";

  for await (const chunk of app.renderPromptStream("structured stream")) {
    seen.add(chunk.type);
    if (chunk.type === "final" && chunk.final) {
      finalHtml = chunk.final.html;
      const raw = chunk.final.llm.raw as { mode?: string } | undefined;
      llmMode = raw?.mode ?? "";
    }
  }

  assert.ok(seen.has("llm-delta"));
  assert.ok(seen.has("final"));
  assert.match(finalHtml, /Structured: structured stream/);
  assert.equal(llmMode, "structured");

  await app.stop();
});

test("core renderPromptStream uses incremental codegen session", async () => {
  const countingCodegen = new CountingIncrementalCodeGenerator();
  const app = createRenderifyApp(
    createDependencies({
      codegen: countingCodegen,
    }),
  );

  await app.start();

  const chunks = [];
  for await (const chunk of app.renderPromptStream("incremental session demo", {
    previewEveryChunks: 1,
  })) {
    chunks.push(chunk.type);
  }

  assert.ok(chunks.includes("preview"));
  assert.ok(countingCodegen.pushDeltaCalls > 0);
  assert.equal(countingCodegen.finalizeCalls, 1);
  assert.ok(countingCodegen.generatePlanCalls <= 1);

  await app.stop();
});

test("core renderPromptStream emits error chunk before throwing", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new StreamingFailureLLM(),
    }),
  );

  await app.start();

  const seenChunkTypes: string[] = [];
  let errorChunkMessage = "";

  await assert.rejects(
    async () => {
      for await (const chunk of app.renderPromptStream("stream failure demo")) {
        seenChunkTypes.push(chunk.type);
        if (chunk.type === "error") {
          errorChunkMessage = chunk.error?.message ?? "";
        }
      }
    },
    (error: unknown) =>
      error instanceof Error && error.message.includes("stream exploded"),
  );

  assert.ok(seenChunkTypes.includes("llm-delta"));
  assert.ok(seenChunkTypes.includes("error"));
  assert.equal(errorChunkMessage, "stream exploded");

  await app.stop();
});

test("core renderPrompt short-circuits when aborted", async () => {
  let llmCalled = 0;

  const app = createRenderifyApp(
    createDependencies({
      llm: {
        configure() {},
        async generateResponse(_req: LLMRequest): Promise<LLMResponse> {
          llmCalled += 1;
          return {
            text: "should not run",
          };
        },
        setPromptTemplate() {},
        getPromptTemplate() {
          return undefined;
        },
      },
    }),
  );

  await app.start();

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      app.renderPrompt("cancel immediately", {
        signal: controller.signal,
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(llmCalled, 0);

  await app.stop();
});
