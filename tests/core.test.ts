import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/codegen/src/index";
import {
  DefaultRenderifyConfig,
  type RenderifyConfigValues,
} from "../packages/config/src/index";
import { DefaultContextManager } from "../packages/context/src/index";
import {
  createRenderifyApp,
  InMemoryTenantGovernor,
  PolicyRejectionError,
  type RenderifyCoreDependencies,
  TenantQuotaExceededError,
} from "../packages/core/src/index";
import { DefaultCustomizationEngine } from "../packages/customization/src/index";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  DefaultLLMInterpreter,
  type LLMInterpreter,
  type LLMRequest,
  type LLMResponse,
  type LLMStructuredRequest,
  type LLMStructuredResponse,
} from "../packages/llm-interpreter/src/index";
import { DefaultPerformanceOptimizer } from "../packages/performance/src/index";
import { DefaultRuntimeManager } from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";
import { DefaultUIRenderer } from "../packages/ui/src/index";

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

class ThrottledConfig extends DefaultRenderifyConfig {
  async load(overrides?: Partial<RenderifyConfigValues>): Promise<void> {
    await super.load(overrides);
    this.set("tenantQuotaPolicy", {
      maxExecutionsPerMinute: 1,
      maxConcurrentExecutions: 1,
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

function createDependencies(
  overrides: Partial<RenderifyCoreDependencies> = {},
): RenderifyCoreDependencies {
  return {
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new DefaultLLMInterpreter(),
    codegen: new DefaultCodeGenerator(),
    runtime: new DefaultRuntimeManager(),
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
    ...overrides,
  };
}

test("core pipeline records plans, audits, rollback and replay", async () => {
  const app = createRenderifyApp(createDependencies());

  await app.start();

  const first = await app.renderPrompt("Build runtime welcome");

  assert.equal(first.audit.status, "succeeded");
  assert.equal(first.audit.mode, "prompt");
  assert.ok(first.html.includes("Build runtime welcome"));

  const plans = app.listPlans();
  assert.equal(plans.length, 1);

  const versions = app.listPlanVersions(first.plan.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, first.plan.version);

  const rollback = await app.rollbackPlan(first.plan.id, first.plan.version);
  assert.equal(rollback.audit.mode, "rollback");
  assert.equal(rollback.audit.status, "succeeded");

  const replay = await app.replayTrace(first.traceId);
  assert.equal(replay.audit.mode, "replay");
  assert.equal(replay.audit.status, "succeeded");

  const audits = app.listAudits();
  assert.equal(audits.length, 3);

  await app.stop();
});

test("core pipeline records rejected audits when policy blocks plan", async () => {
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

  const audits = app.listAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, "rejected");
  assert.equal(audits[0].mode, "prompt");
  assert.ok((audits[0].securityIssueCount ?? 0) > 0);

  await app.stop();
});

test("core dispatchEvent updates state and records event audit mode", async () => {
  const app = createRenderifyApp(createDependencies());

  await app.start();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_counter_plan",
    version: 1,
    root: createElementNode("section", undefined, [
      createTextNode("Count={{state.count}}"),
    ]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 0,
      },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  };

  await app.renderPlan(plan, { prompt: "seed plan" });
  const eventResult = await app.dispatchEvent(plan.id, { type: "increment" });

  assert.equal(eventResult.audit.mode, "event");
  assert.equal(eventResult.audit.status, "succeeded");
  assert.equal(eventResult.execution.state?.count, 1);
  assert.equal(app.getPlanState(plan.id)?.count, 1);
  assert.equal(eventResult.execution.handledEvent?.type, "increment");

  await app.stop();
});

test("core clearHistory clears plan/audit records and runtime state", async () => {
  const app = createRenderifyApp(createDependencies());

  await app.start();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "core_clear_history_plan",
    version: 1,
    root: createElementNode("section", undefined, [
      createTextNode("Count={{state.count}}"),
    ]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 0,
      },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  };

  await app.renderPlan(plan, { prompt: "seed" });
  await app.dispatchEvent(plan.id, { type: "increment" });

  assert.equal(app.getPlanState(plan.id)?.count, 1);
  assert.ok(app.listPlans().length > 0);
  assert.ok(app.listAudits().length > 0);

  app.clearHistory();

  assert.equal(app.getPlanState(plan.id), undefined);
  assert.equal(app.listPlans().length, 0);
  assert.equal(app.listAudits().length, 0);

  await app.stop();
});

test("core enforces tenant quota and records throttled audit", async () => {
  const app = createRenderifyApp(
    createDependencies({
      config: new ThrottledConfig(),
      tenantGovernor: new InMemoryTenantGovernor(),
    }),
  );

  await app.start();

  await app.renderPrompt("first run ok");

  await assert.rejects(
    () => app.renderPrompt("second run throttled"),
    (error: unknown) => error instanceof TenantQuotaExceededError,
  );

  const audits = app.listAudits();
  assert.equal(audits.length, 2);
  assert.ok(audits.some((audit) => audit.status === "throttled"));
  assert.ok(audits.some((audit) => audit.tenantId === "anonymous"));

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
