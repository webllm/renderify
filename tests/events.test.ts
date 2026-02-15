import assert from "node:assert/strict";
import test from "node:test";
import {
  createRenderifyApp,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultUIRenderer,
  type LLMInterpreter,
  PolicyRejectionError,
  type RenderifyCoreDependencies,
} from "../packages/core/src/index";
import type {
  RuntimeDiagnostic,
  RuntimeExecutionResult,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "../packages/ir/src/index";
import {
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
} from "../packages/ir/src/index";
import type {
  RuntimeExecutionInput,
  RuntimeManager,
  RuntimePlanProbeResult,
} from "../packages/runtime/src/runtime-manager.types";
import type {
  RuntimeSecurityPolicy,
  RuntimeSecurityProfile,
  SecurityChecker,
  SecurityCheckResult,
  SecurityInitializationInput,
} from "../packages/security/src/index";

class NoopLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(): Promise<{ text: string }> {
    return { text: "noop" };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

class MockRuntimeManager implements RuntimeManager {
  public executeError: Error | undefined;
  private readonly state = new Map<string, RuntimeStateSnapshot>();

  async initialize(): Promise<void> {}

  async terminate(): Promise<void> {}

  async probePlan(plan: RuntimePlan): Promise<RuntimePlanProbeResult> {
    return {
      planId: plan.id,
      diagnostics: [],
      dependencies: [],
    };
  }

  async executePlan(plan: RuntimePlan): Promise<RuntimeExecutionResult> {
    return this.execute({ plan });
  }

  async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
    if (this.executeError) {
      throw this.executeError;
    }

    return {
      planId: input.plan.id,
      root: createTextNode(`ok:${input.plan.id}`),
      diagnostics: [],
    };
  }

  async compile(_plan: RuntimePlan): Promise<string> {
    return "";
  }

  getPlanState(planId: string): RuntimeStateSnapshot | undefined {
    return this.state.get(planId);
  }

  setPlanState(planId: string, snapshot: RuntimeStateSnapshot): void {
    this.state.set(planId, snapshot);
  }

  clearPlanState(planId: string): void {
    this.state.delete(planId);
  }
}

class MockSecurityChecker implements SecurityChecker {
  public safe = true;
  public readonly diagnostics: RuntimeDiagnostic[] = [];

  initialize(_input?: SecurityInitializationInput): void {}

  getPolicy(): RuntimeSecurityPolicy {
    return {
      blockedTags: [],
      maxTreeDepth: 100,
      maxNodeCount: 10_000,
      allowInlineEventHandlers: false,
      allowedModules: ["npm:"],
      allowedNetworkHosts: [],
      allowArbitraryNetwork: false,
      allowedExecutionProfiles: ["standard"],
      maxTransitionsPerPlan: 100,
      maxActionsPerTransition: 100,
      maxAllowedImports: 100,
      maxAllowedExecutionMs: 60_000,
      maxAllowedComponentInvocations: 10_000,
      allowRuntimeSourceModules: true,
      maxRuntimeSourceBytes: 1_000_000,
      supportedSpecVersions: [DEFAULT_RUNTIME_PLAN_SPEC_VERSION],
      requireSpecVersion: true,
      requireModuleManifestForBareSpecifiers: false,
      requireModuleIntegrity: false,
      allowDynamicSourceImports: true,
      sourceBannedPatternStrings: [],
      maxSourceImportSpecifiers: 1000,
    };
  }

  getProfile(): RuntimeSecurityProfile {
    return "relaxed";
  }

  async checkPlan(_plan: RuntimePlan): Promise<SecurityCheckResult> {
    return {
      safe: this.safe,
      issues: this.safe ? [] : ["blocked"],
      diagnostics: this.diagnostics,
    };
  }

  checkModuleSpecifier(): SecurityCheckResult {
    return {
      safe: true,
      issues: [],
      diagnostics: [],
    };
  }

  checkCapabilities(): SecurityCheckResult {
    return {
      safe: true,
      issues: [],
      diagnostics: [],
    };
  }
}

function createPlan(id: string): RuntimePlan {
  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id,
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: createTextNode(`plan:${id}`),
  };
}

function createDependencies(
  runtime: MockRuntimeManager,
  security: MockSecurityChecker,
): RenderifyCoreDependencies {
  return {
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new NoopLLM(),
    codegen: new DefaultCodeGenerator(),
    runtime,
    security,
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
  };
}

test("events: started and stopped are emitted exactly once per lifecycle", async () => {
  const runtime = new MockRuntimeManager();
  const security = new MockSecurityChecker();
  const app = createRenderifyApp(createDependencies(runtime, security));

  let startedCount = 0;
  let stoppedCount = 0;

  app.on("started", () => {
    startedCount += 1;
  });
  app.on("stopped", () => {
    stoppedCount += 1;
  });

  await app.start();
  await app.start();
  await app.stop();
  await app.stop();

  assert.equal(startedCount, 1);
  assert.equal(stoppedCount, 1);
});

test("events: rendered emits trace/plan metadata on success", async () => {
  const runtime = new MockRuntimeManager();
  const security = new MockSecurityChecker();
  const app = createRenderifyApp(createDependencies(runtime, security));

  const renderedPayloads: Array<Record<string, unknown>> = [];
  app.on("rendered", (payload) => {
    renderedPayloads.push(payload as Record<string, unknown>);
  });

  await app.start();
  await app.renderPlan(createPlan("events_success_plan"), {
    traceId: "trace_events_success",
    prompt: "from-test",
  });
  await app.stop();

  assert.equal(renderedPayloads.length, 1);
  assert.equal(renderedPayloads[0].traceId, "trace_events_success");
  assert.equal(renderedPayloads[0].planId, "events_success_plan");
  assert.equal(renderedPayloads[0].prompt, "from-test");
});

test("events: policyRejected and renderFailed fire when security denies plan", async () => {
  const runtime = new MockRuntimeManager();
  const security = new MockSecurityChecker();
  security.safe = false;

  const app = createRenderifyApp(createDependencies(runtime, security));

  let policyRejectedCount = 0;
  let renderFailedCount = 0;

  app.on("policyRejected", () => {
    policyRejectedCount += 1;
  });
  app.on("renderFailed", () => {
    renderFailedCount += 1;
  });

  await app.start();
  await assert.rejects(
    () => app.renderPlan(createPlan("events_policy_reject_plan")),
    (error: unknown) => error instanceof PolicyRejectionError,
  );
  await app.stop();

  assert.equal(policyRejectedCount, 1);
  assert.equal(renderFailedCount, 1);
});

test("events: renderFailed fires when runtime execution throws", async () => {
  const runtime = new MockRuntimeManager();
  runtime.executeError = new Error("runtime exploded");
  const security = new MockSecurityChecker();

  const app = createRenderifyApp(createDependencies(runtime, security));

  const failures: Array<{ error?: unknown }> = [];
  app.on("renderFailed", (payload) => {
    failures.push(payload as { error?: unknown });
  });

  await app.start();
  await assert.rejects(
    () => app.renderPlan(createPlan("events_runtime_failure_plan")),
    /runtime exploded/,
  );
  await app.stop();

  assert.equal(failures.length, 1);
  assert.match(
    String((failures[0].error as Error).message),
    /runtime exploded/,
  );
});

test("events: on() unsubscribe detaches listener and emit supports fan-out", () => {
  const runtime = new MockRuntimeManager();
  const security = new MockSecurityChecker();
  const app = createRenderifyApp(createDependencies(runtime, security));

  const seen: string[] = [];
  const unsubA = app.on("custom", (payload) => {
    seen.push(`a:${String(payload)}`);
  });
  app.on("custom", (payload) => {
    seen.push(`b:${String(payload)}`);
  });

  app.emit("custom", 1);
  unsubA();
  app.emit("custom", 2);

  assert.deepEqual(seen, ["a:1", "b:1", "b:2"]);
});
