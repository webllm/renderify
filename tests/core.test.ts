import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/core/src/codegen";
import {
  DefaultRenderifyConfig,
  type RenderifyConfigValues,
} from "../packages/core/src/config";
import {
  DefaultSecurityChecker as CoreDefaultSecurityChecker,
  createRenderifyApp,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  listSecurityProfiles as listCoreSecurityProfiles,
  PolicyRejectionError,
  type RenderifyCoreDependencies,
  StructuredPlanGenerationError,
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
import {
  DefaultRuntimeManager,
  type RuntimeExecutionInput,
} from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";

test("core entry re-exports the security package API", () => {
  assert.equal(CoreDefaultSecurityChecker, DefaultSecurityChecker);
  assert.deepEqual(listCoreSecurityProfiles(), [
    "strict",
    "balanced",
    "trusted",
    "relaxed",
  ]);
});

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

class PolicyPromptCapturingLLM extends StructuredOnlyLLM {
  readonly systemPrompts: Array<string | undefined> = [];

  override async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    this.systemPrompts.push(req.systemPrompt);
    return super.generateStructuredResponse(req);
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

class RecoveringTextFallbackLLM extends InvalidStructuredLLM {
  override async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const plan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "recovered_text_fallback_plan",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "section",
        children: [{ type: "text", value: `Recovered: ${req.prompt}` }],
      },
    };
    return {
      text: JSON.stringify(plan),
      model: "recovering-text-fallback",
    };
  }
}

class TerminalStructuredRecoveryLLM extends InvalidStructuredLLM {
  structuredCalls = 0;
  readonly structuredPrompts: string[] = [];

  override async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    this.structuredCalls += 1;
    this.structuredPrompts.push(req.prompt);
    if (this.structuredCalls < 3) {
      return {
        text: '{"state":{}}',
        value: { state: {} } as T,
        valid: false,
        errors: [
          "Structured payload is not a valid RuntimePlan",
          "state must contain an initial object and optional valid transitions; omit state when unused",
        ],
        model: "terminal-structured-recovery",
      };
    }

    const plan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "terminal_structured_recovery_plan",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "section",
        children: [{ type: "text", value: "Recovered terminal plan" }],
      },
    };
    return {
      text: JSON.stringify(plan),
      value: plan as T,
      valid: true,
      model: "terminal-structured-recovery",
    };
  }
}

class FailedTerminalRecoveryWithValidTextLLM extends RecoveringTextFallbackLLM {
  structuredCalls = 0;

  override async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    this.structuredCalls += 1;
    if (this.structuredCalls === 3) {
      throw new Error("terminal recovery unavailable");
    }
    return super.generateStructuredResponse(req);
  }
}

class StructuredInvalidCountingLLM implements LLMInterpreter {
  structuredCalls = 0;
  textCalls = 0;
  readonly structuredPrompts: string[] = [];
  readonly textPrompts: string[] = [];
  readonly textSystemPrompts: Array<string | undefined> = [];

  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    this.textCalls += 1;
    this.textPrompts.push(req.prompt);
    this.textSystemPrompts.push(req.systemPrompt);
    const originalPrompt = req.prompt.split("\n\n", 1)[0] ?? req.prompt;
    return {
      text: `text fallback: ${originalPrompt}`,
      model: "structured-invalid-counting",
      raw: { mode: "text" },
    };
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    this.structuredCalls += 1;
    this.structuredPrompts.push(req.prompt);
    const plan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "structured_invalid_but_parseable_plan",
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
            value: `Structured invalid: ${req.prompt}`,
          },
        ],
      },
    };

    return {
      text: JSON.stringify(plan),
      value: plan as T,
      valid: false,
      errors: ["forced invalid structured payload"],
      model: "structured-invalid-counting",
      raw: { mode: "structured" },
    };
  }

  setPromptTemplate(_templateName: string, _templateContent: string): void {}

  getPromptTemplate(_templateName: string): string | undefined {
    return undefined;
  }
}

class LLMStructuredControlConfig extends DefaultRenderifyConfig {
  constructor(
    private readonly controls: {
      retryOnInvalid: boolean;
      fallbackToText: boolean;
    },
  ) {
    super();
  }

  override async load(
    overrides?: Partial<RenderifyConfigValues>,
  ): Promise<void> {
    await super.load(overrides);
    this.set("llmStructuredRetryOnInvalid", this.controls.retryOnInvalid);
    this.set("llmStructuredFallbackToText", this.controls.fallbackToText);
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

class StreamingPlainTextLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: `plain stream output for ${req.prompt}`,
      model: "streaming-plain-text",
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const text = `plain stream output for ${req.prompt}`;
    const firstDelta = text.slice(0, 8);
    const secondDelta = text.slice(8);

    yield {
      delta: firstDelta,
      text: firstDelta,
      done: false,
      index: 1,
      model: "streaming-plain-text",
    };
    yield {
      delta: secondDelta,
      text,
      done: true,
      index: 2,
      model: "streaming-plain-text",
    };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

class CleanupTrackingLLM implements LLMInterpreter {
  streamClosed = false;

  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: req.prompt,
      model: "cleanup-tracking",
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    try {
      yield {
        delta: req.prompt,
        text: req.prompt,
        done: false,
        index: 1,
        model: "cleanup-tracking",
      };

      await new Promise<void>(() => undefined);
    } finally {
      this.streamClosed = true;
    }
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

class GatedLifecycleRuntime extends DefaultRuntimeManager {
  initializeCalls = 0;
  terminateCalls = 0;
  readonly initializeStarted = createDeferred();
  readonly terminateStarted = createDeferred();

  constructor(
    private readonly initializeGate: Promise<void>,
    private readonly terminateGate: Promise<void>,
  ) {
    super();
  }

  override async initialize(): Promise<void> {
    this.initializeCalls += 1;
    this.initializeStarted.resolve();
    await this.initializeGate;
    await super.initialize();
  }

  override async terminate(): Promise<void> {
    this.terminateCalls += 1;
    this.terminateStarted.resolve();
    await this.terminateGate;
    await super.terminate();
  }
}

class ContextCapturingRuntime extends DefaultRuntimeManager {
  readonly inputs: RuntimeExecutionInput[] = [];

  override async execute(input: RuntimeExecutionInput) {
    this.inputs.push(input);
    return super.execute(input);
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

test("core serializes concurrent lifecycle calls", async () => {
  const initializeGate = createDeferred();
  const terminateGate = createDeferred();
  const runtime = new GatedLifecycleRuntime(
    initializeGate.promise,
    terminateGate.promise,
  );
  const app = createRenderifyApp(createDependencies({ runtime }));
  let startedEvents = 0;
  let stoppedEvents = 0;
  app.on("started", () => {
    startedEvents += 1;
  });
  app.on("stopped", () => {
    stoppedEvents += 1;
  });

  const firstStart = app.start();
  const secondStart = app.start();
  await runtime.initializeStarted.promise;
  assert.equal(runtime.initializeCalls, 1);

  initializeGate.resolve();
  await Promise.all([firstStart, secondStart]);
  assert.equal(runtime.initializeCalls, 1);
  assert.equal(startedEvents, 1);

  const firstStop = app.stop();
  const secondStop = app.stop();
  await runtime.terminateStarted.promise;
  assert.equal(runtime.terminateCalls, 1);

  terminateGate.resolve();
  await Promise.all([firstStop, secondStop]);
  assert.equal(runtime.terminateCalls, 1);
  assert.equal(stoppedEvents, 1);
});

test("core queues stop requested while start is in progress", async () => {
  const initializeGate = createDeferred();
  const terminateGate = createDeferred();
  const runtime = new GatedLifecycleRuntime(
    initializeGate.promise,
    terminateGate.promise,
  );
  const app = createRenderifyApp(createDependencies({ runtime }));

  const starting = app.start();
  await runtime.initializeStarted.promise;
  const stopping = app.stop();

  initializeGate.resolve();
  await runtime.terminateStarted.promise;
  terminateGate.resolve();
  await Promise.all([starting, stopping]);

  assert.equal(runtime.initializeCalls, 1);
  assert.equal(runtime.terminateCalls, 1);
  await assert.rejects(
    () =>
      app.renderPlan({
        specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
        id: "lifecycle_stopped_plan",
        version: 1,
        root: createTextNode("stopped"),
      }),
    /RenderifyApp is not started/,
  );
});

test("core keeps the security policy authoritative for runtime source execution", async () => {
  const runtime = new DefaultRuntimeManager({
    allowRuntimeSourceExecution: true,
  });
  const app = createRenderifyApp(
    createDependencies({
      runtime,
      runtimeOptionOverrides: {
        allowRuntimeSourceExecution: true,
      },
    }),
  );

  await app.start();

  assert.equal(
    (runtime as unknown as { allowRuntimeSourceExecution?: boolean })
      .allowRuntimeSourceExecution,
    false,
  );

  await app.stop();
});

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

test("core passes normalized application context to runtime and previews", async () => {
  const context = new DefaultContextManager();
  const runtime = new ContextCapturingRuntime();
  const app = createRenderifyApp(
    createDependencies({
      context,
      runtime,
    }),
  );
  await app.start();

  const circular: Record<string, unknown> = { label: "safe" };
  circular.self = circular;
  context.updateContext({
    user: {
      id: "user_42",
      name: "Ada",
      role: "operator",
    },
    tenant: {
      id: "tenant_7",
    },
    nonFinite: Number.POSITIVE_INFINITY,
    circular,
  });

  const result = await app.renderPlan({
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_runtime_context_plan",
    version: 1,
    root: createTextNode(
      "id={{context.userId}}, name={{vars.user.name}}, tenant={{vars.tenant.id}}, invalid={{vars.nonFinite}}, cycle={{vars.circular.self}}",
    ),
    capabilities: {
      domWrite: true,
    },
  });

  assert.match(
    result.html,
    /id=user_42, name=Ada, tenant=tenant_7, invalid=, cycle=/,
  );

  let sawPreview = false;
  for await (const chunk of app.renderPromptStream("context preview", {
    previewEveryChunks: 1,
  })) {
    if (chunk.type === "preview") {
      sawPreview = true;
    }
  }

  assert.equal(sawPreview, true);
  assert.ok(runtime.inputs.length >= 3);
  for (const input of runtime.inputs) {
    assert.equal(input.context?.userId, "user_42");
    assert.deepEqual(input.context?.variables?.user, {
      id: "user_42",
      name: "Ada",
      role: "operator",
    });
    assert.deepEqual(input.context?.variables?.tenant, {
      id: "tenant_7",
    });
    assert.equal(input.context?.variables?.nonFinite, null);
    assert.deepEqual(input.context?.variables?.circular, {
      label: "safe",
      self: null,
    });
  }

  await app.stop();
});

test("core rechecks policy after beforeRuntime hook plan mutations", async () => {
  const customization = new DefaultCustomizationEngine();
  customization.registerPlugin({
    name: "mutate-plan-before-runtime",
    hooks: {
      beforeRuntime: (payload) => {
        const runtimeInput = payload as {
          plan: RuntimePlan;
        };
        return {
          ...runtimeInput,
          plan: {
            ...runtimeInput.plan,
            root: createElementNode("script", undefined, [
              createTextNode("mutated"),
            ]),
          },
        };
      },
    },
  });

  const app = createRenderifyApp(
    createDependencies({
      customization,
    }),
  );

  await app.start();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_runtime_mutation_policy_recheck",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("safe")]),
    capabilities: {
      domWrite: true,
    },
  };

  await assert.rejects(
    () => app.renderPlan(plan),
    (error: unknown) => error instanceof PolicyRejectionError,
  );

  await app.stop();
});

test("core reports the plan and security result used after beforeRuntime", async () => {
  const customization = new DefaultCustomizationEngine();
  const executedPlanIds: string[] = [];
  const renderedPlanIds: string[] = [];
  const runtime = new ContextCapturingRuntime();
  const security = new DefaultSecurityChecker();
  const originalExecute = runtime.execute.bind(runtime);
  const originalCheckPlan = security.checkPlan.bind(security);
  runtime.execute = async (input) => {
    executedPlanIds.push(input.plan.id);
    return originalExecute(input);
  };
  security.checkPlan = async (plan) => {
    const result = await originalCheckPlan(plan);
    return {
      ...result,
      diagnostics: [
        ...result.diagnostics,
        {
          level: "info",
          code: `CHECKED_${plan.id}`,
          message: `Checked ${plan.id}`,
        },
      ],
    };
  };
  customization.registerPlugin({
    name: "replace-plan-before-runtime",
    hooks: {
      beforeRuntime: (payload) => {
        const input = payload as RuntimeExecutionInput;
        return {
          ...input,
          plan: {
            ...input.plan,
            id: "core_runtime_replaced_plan",
            root: createTextNode("replaced before runtime"),
          },
        };
      },
    },
  });
  const app = createRenderifyApp(
    createDependencies({
      customization,
      runtime,
      security,
    }),
  );
  app.on("rendered", (payload) => {
    const event = payload as { planId?: string };
    if (event.planId) {
      renderedPlanIds.push(event.planId);
    }
  });
  await app.start();

  const result = await app.renderPlan({
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_runtime_original_plan",
    version: 1,
    root: createTextNode("original"),
    capabilities: {
      domWrite: true,
    },
  });

  assert.equal(result.plan.id, "core_runtime_replaced_plan");
  assert.equal(result.execution.planId, "core_runtime_replaced_plan");
  assert.match(result.html, /replaced before runtime/);
  assert.equal(result.security.safe, true);
  assert.equal(
    result.security.diagnostics.some(
      (diagnostic) => diagnostic.code === "CHECKED_core_runtime_replaced_plan",
    ),
    true,
  );
  assert.equal(
    result.security.diagnostics.some(
      (diagnostic) => diagnostic.code === "CHECKED_core_runtime_original_plan",
    ),
    false,
  );
  assert.deepEqual(executedPlanIds, ["core_runtime_replaced_plan"]);
  assert.deepEqual(renderedPlanIds, ["core_runtime_replaced_plan"]);

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

test("core tells the LLM when active policy forbids source plans", async () => {
  const balancedLlm = new PolicyPromptCapturingLLM();
  const balancedApp = createRenderifyApp(
    createDependencies({
      llm: balancedLlm,
    }),
  );
  await balancedApp.start();
  await balancedApp.renderPrompt("balanced policy plan");
  assert.match(
    balancedLlm.systemPrompts[0] ?? "",
    /rejects every RuntimePlan containing a top-level source module/,
  );
  assert.match(
    balancedLlm.systemPrompts[0] ?? "",
    /templates use \{\{state\.path\}\} path lookups only; never use \$\{\.\.\.\}/i,
  );
  assert.match(
    balancedLlm.systemPrompts[0] ?? "",
    /do not capture live browser values/i,
  );
  await balancedApp.stop();

  const trustedLlm = new PolicyPromptCapturingLLM();
  const trustedApp = createRenderifyApp(
    createDependencies({
      configLoadOverrides: { securityProfile: "trusted" },
      llm: trustedLlm,
    }),
  );
  await trustedApp.start();
  await trustedApp.renderPrompt("trusted policy plan");
  assert.equal(trustedLlm.systemPrompts[0], undefined);
  await trustedApp.stop();
});

test("core rejects text fallback that still is not a RuntimePlan", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new InvalidStructuredLLM(),
    }),
  );

  await app.start();

  await assert.rejects(
    app.renderPrompt("fallback"),
    (error: unknown) =>
      error instanceof StructuredPlanGenerationError &&
      error.errors.includes("invalid schema"),
  );

  await app.stop();
});

test("core accepts text fallback when it contains a RuntimePlan", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new RecoveringTextFallbackLLM(),
    }),
  );

  await app.start();

  const result = await app.renderPrompt("fallback recovery");
  assert.match(result.html, /Recovered: fallback recovery/);
  const raw = result.llm.raw as { mode?: string } | undefined;
  assert.equal(raw?.mode, "fallback-text");

  await app.stop();
});

test("core performs a final structured recovery after text fallback", async () => {
  const llm = new TerminalStructuredRecoveryLLM();
  const app = createRenderifyApp(createDependencies({ llm }));

  await app.start();

  const result = await app.renderPrompt("terminal recovery");
  assert.match(result.html, /Recovered terminal plan/);
  assert.equal(llm.structuredCalls, 3);
  assert.match(
    llm.structuredPrompts[2] ?? "",
    /Omit these invalid optional top-level fields completely: state/,
  );
  const raw = result.llm.raw as { mode?: string } | undefined;
  assert.equal(raw?.mode, "structured-recovery");

  await app.stop();
});

test("core preserves a valid text fallback when terminal recovery errors", async () => {
  const llm = new FailedTerminalRecoveryWithValidTextLLM();
  const app = createRenderifyApp(createDependencies({ llm }));

  await app.start();

  const result = await app.renderPrompt("fallback survives recovery error");
  assert.match(result.html, /Recovered: fallback survives recovery error/);
  assert.equal(llm.structuredCalls, 3);
  const raw = result.llm.raw as {
    mode?: string;
    structuredErrors?: string[];
  };
  assert.equal(raw.mode, "fallback-text");
  assert.ok(
    raw.structuredErrors?.some((error) =>
      error.includes("terminal recovery unavailable"),
    ),
  );

  await app.stop();
});

test("core can attempt text fallback without accepting an invalid plan", async () => {
  const llm = new StructuredInvalidCountingLLM();
  const app = createRenderifyApp(
    createDependencies({
      config: new LLMStructuredControlConfig({
        retryOnInvalid: false,
        fallbackToText: true,
      }),
      llm,
    }),
  );

  await app.start();

  await assert.rejects(
    app.renderPrompt("retry-off"),
    StructuredPlanGenerationError,
  );
  assert.equal(llm.structuredCalls, 1);
  assert.equal(llm.textCalls, 1);
  assert.match(llm.textPrompts[0] ?? "", /Repair this previous output/);
  assert.match(llm.textSystemPrompts[0] ?? "", /RuntimePlan JSON object/);

  await app.stop();
});

test("core includes the rejected payload in structured repair requests", async () => {
  const llm = new StructuredInvalidCountingLLM();
  const app = createRenderifyApp(
    createDependencies({
      config: new LLMStructuredControlConfig({
        retryOnInvalid: true,
        fallbackToText: false,
      }),
      llm,
    }),
  );

  await app.start();
  await app.renderPrompt("repair-context");

  assert.equal(llm.structuredCalls, 2);
  assert.match(
    llm.structuredPrompts[1] ?? "",
    /structured_invalid_but_parseable_plan/,
  );
  assert.match(llm.structuredPrompts[1] ?? "", /Repair this previous output/);
  await app.stop();
});

test("core can disable structured text fallback to keep single llm request", async () => {
  const llm = new StructuredInvalidCountingLLM();
  const app = createRenderifyApp(
    createDependencies({
      config: new LLMStructuredControlConfig({
        retryOnInvalid: false,
        fallbackToText: false,
      }),
      llm,
    }),
  );

  await app.start();

  const result = await app.renderPrompt("single-shot");
  assert.match(result.html, /Structured invalid: single-shot/);
  const raw = result.llm.raw as { mode?: string } | undefined;
  assert.equal(raw?.mode, "structured-invalid");
  assert.equal(llm.structuredCalls, 1);
  assert.equal(llm.textCalls, 0);

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
  const deltas: string[] = [];
  let finalHtml = "";
  let finalLlmText = "";
  let llmMode = "";

  for await (const chunk of app.renderPromptStream("structured stream")) {
    seen.add(chunk.type);
    if (chunk.type === "llm-delta") {
      deltas.push(chunk.delta ?? "");
    }
    if (chunk.type === "final" && chunk.final) {
      finalHtml = chunk.final.html;
      finalLlmText = chunk.final.llm.text;
      const raw = chunk.final.llm.raw as { mode?: string } | undefined;
      llmMode = raw?.mode ?? "";
    }
  }

  assert.ok(seen.has("llm-delta"));
  assert.ok(seen.has("final"));
  assert.deepEqual(deltas, [finalLlmText]);
  assert.match(finalHtml, /Structured: structured stream/);
  assert.equal(llmMode, "structured");

  await app.stop();
});

test("core renderPromptStream reports invalid structured text fallback", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new InvalidStructuredLLM(),
    }),
  );

  await app.start();

  const seenChunkTypes: string[] = [];
  let errorName = "";
  await assert.rejects(async () => {
    for await (const chunk of app.renderPromptStream(
      "invalid structured stream",
    )) {
      seenChunkTypes.push(chunk.type);
      if (chunk.type === "error") {
        errorName = chunk.error?.name ?? "";
      }
    }
  }, StructuredPlanGenerationError);

  assert.ok(seenChunkTypes.includes("llm-delta"));
  assert.ok(seenChunkTypes.includes("error"));
  assert.ok(!seenChunkTypes.includes("final"));
  assert.equal(errorName, "StructuredPlanGenerationError");

  await app.stop();
});

test("core renderPromptStream completes after terminal structured recovery", async () => {
  const llm = new TerminalStructuredRecoveryLLM();
  const app = createRenderifyApp(createDependencies({ llm }));

  await app.start();

  let finalHtml = "";
  let finalMode = "";
  for await (const chunk of app.renderPromptStream(
    "terminal stream recovery",
  )) {
    if (chunk.type === "final" && chunk.final) {
      finalHtml = chunk.final.html;
      finalMode =
        (chunk.final.llm.raw as { mode?: string } | undefined)?.mode ?? "";
    }
  }

  assert.match(finalHtml, /Recovered terminal plan/);
  assert.equal(finalMode, "structured-recovery");
  assert.equal(llm.structuredCalls, 3);

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

test("core renderPromptStream suppresses noisy text-fallback previews", async () => {
  const app = createRenderifyApp(
    createDependencies({
      llm: new StreamingPlainTextLLM(),
    }),
  );
  await app.start();

  const chunkTypes: string[] = [];
  let finalHtml = "";

  for await (const chunk of app.renderPromptStream("text stream fallback", {
    previewEveryChunks: 1,
  })) {
    chunkTypes.push(chunk.type);
    if (chunk.type === "final" && chunk.final) {
      finalHtml = chunk.final.html;
    }
  }

  assert.ok(chunkTypes.includes("llm-delta"));
  assert.ok(!chunkTypes.includes("preview"));
  assert.ok(chunkTypes.includes("final"));
  assert.match(finalHtml, /text stream fallback/);

  await app.stop();
});

test("core renderPromptStream supports 120 concurrent streams", async () => {
  const app = createRenderifyApp(createDependencies());
  await app.start();

  const concurrentStreams = 120;
  const started = Date.now();
  const runs = await Promise.all(
    Array.from({ length: concurrentStreams }, async (_, index) => {
      let sawDelta = false;
      let sawFinal = false;
      let finalHtml = "";

      for await (const chunk of app.renderPromptStream(`parallel-${index}`, {
        previewEveryChunks: 64,
      })) {
        if (chunk.type === "llm-delta") {
          sawDelta = true;
        }

        if (chunk.type === "final" && chunk.final) {
          sawFinal = true;
          finalHtml = chunk.final.html;
        }
      }

      return {
        sawDelta,
        sawFinal,
        finalHtml,
      };
    }),
  );
  const elapsed = Date.now() - started;

  assert.equal(runs.length, concurrentStreams);
  assert.ok(runs.every((entry) => entry.sawDelta));
  assert.ok(runs.every((entry) => entry.sawFinal));
  assert.ok(runs.every((entry) => entry.finalHtml.length > 0));
  assert.ok(
    elapsed < 25000,
    `concurrent stream regression: elapsed=${elapsed}ms`,
  );

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

test("core renderPromptStream closes upstream and metrics when consumer breaks", async () => {
  const llm = new CleanupTrackingLLM();
  const performance = new DefaultPerformanceOptimizer();
  const app = createRenderifyApp(
    createDependencies({
      llm,
      performance,
    }),
  );
  await app.start();

  for await (const chunk of app.renderPromptStream("stop after first chunk")) {
    assert.equal(chunk.type, "llm-delta");
    break;
  }

  assert.equal(llm.streamClosed, true);
  assert.equal(performance.getMetrics().length, 1);

  await app.stop();
});

test("core renderPromptStream closes upstream and metrics when signal aborts", async () => {
  const llm = new CleanupTrackingLLM();
  const performance = new DefaultPerformanceOptimizer();
  const app = createRenderifyApp(
    createDependencies({
      llm,
      performance,
    }),
  );
  await app.start();

  const controller = new AbortController();
  const stream = app.renderPromptStream("abort after first chunk", {
    signal: controller.signal,
  });
  const first = await stream.next();
  assert.equal(first.done, false);
  if (first.done) {
    throw new Error("expected initial stream chunk");
  }
  assert.equal(first.value.type, "llm-delta");

  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(llm.streamClosed, true);
  assert.equal(performance.getMetrics().length, 1);

  await stream.return(undefined as never);
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
