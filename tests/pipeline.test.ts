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
  type LLMRequest,
  type LLMResponse,
  type PluginContext,
  type RenderifyCoreDependencies,
} from "../packages/core/src/index";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import { DefaultRuntimeManager } from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";

class JsonPlanLLM implements LLMInterpreter {
  public calls = 0;

  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;

    const plan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "pipeline_json_plan",
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
            value: `LLM:${req.prompt}`,
          },
        ],
      },
    };

    return {
      text: JSON.stringify(plan),
      model: "pipeline-llm",
      tokensUsed: 42,
    };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

function createDependencies(
  overrides: Partial<RenderifyCoreDependencies> = {},
): RenderifyCoreDependencies {
  return {
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new JsonPlanLLM(),
    codegen: new DefaultCodeGenerator(),
    runtime: new DefaultRuntimeManager(),
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
    ...overrides,
  };
}

test("pipeline runs full prompt flow with plugin hook transformations", async () => {
  const llm = new JsonPlanLLM();
  const customization = new DefaultCustomizationEngine();
  const hookOrder: string[] = [];

  customization.registerPlugin({
    name: "pipeline-hooks",
    hooks: {
      beforeLLM: async (payload: unknown, context: PluginContext) => {
        hookOrder.push(context.hookName);
        return `${String(payload)} [hook-before-llm]`;
      },
      afterCodeGen: async (payload: unknown, context: PluginContext) => {
        hookOrder.push(context.hookName);
        const plan = payload as RuntimePlan;
        return {
          ...plan,
          root: createElementNode("section", undefined, [
            createTextNode("hook-after-codegen"),
          ]),
        };
      },
      afterRender: async (payload: unknown, context: PluginContext) => {
        hookOrder.push(context.hookName);
        return `${String(payload)}<!--hook-after-render-->`;
      },
    },
  });

  const app = createRenderifyApp(
    createDependencies({
      llm,
      customization,
    }),
  );

  await app.start();
  try {
    const result = await app.renderPrompt("build dashboard");

    assert.equal(llm.calls, 1);
    assert.match(result.llm.text, /\[hook-before-llm\]/);
    assert.match(result.html, /hook-after-codegen/);
    assert.match(result.html, /hook-after-render/);
    assert.ok(hookOrder.includes("beforeLLM"));
    assert.ok(hookOrder.includes("afterCodeGen"));
    assert.ok(hookOrder.includes("afterRender"));
  } finally {
    await app.stop();
  }
});

test("pipeline renderPlan bypasses llm stage", async () => {
  const llm = new JsonPlanLLM();
  const app = createRenderifyApp(
    createDependencies({
      llm,
    }),
  );

  await app.start();
  try {
    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "pipeline_render_plan",
      version: 1,
      capabilities: {
        domWrite: true,
      },
      root: createElementNode("section", undefined, [
        createTextNode("from-plan"),
      ]),
    };

    const result = await app.renderPlan(plan, {
      prompt: "render-plan-test",
    });

    assert.match(result.html, /from-plan/);
    assert.equal(llm.calls, 0);
  } finally {
    await app.stop();
  }
});
