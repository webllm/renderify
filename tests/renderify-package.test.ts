import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMInterpreter,
  LLMRequest,
  LLMResponse,
} from "../packages/core/src/index";
import type { RuntimePlan } from "../packages/ir/src/index";
import {
  createRenderify,
  renderPlanOnce,
  renderPromptOnce,
} from "../packages/renderify/src/index";

class StaticPlanLLM implements LLMInterpreter {
  private readonly templates = new Map<string, string>();

  configure(): void {}

  async generateResponse(_req: LLMRequest): Promise<LLMResponse> {
    return {
      text: JSON.stringify({
        specVersion: "runtime-plan/v1",
        id: "llm-plan",
        version: 1,
        capabilities: { domWrite: true },
        root: {
          type: "element",
          tag: "div",
          children: [{ type: "text", value: "Hello from LLM" }],
        },
      }),
    };
  }

  setPromptTemplate(name: string, templateContent: string): void {
    this.templates.set(name, templateContent);
  }

  getPromptTemplate(name: string): string | undefined {
    return this.templates.get(name);
  }
}

test("renderify facade createRenderify composes default app dependencies", async () => {
  const { app, dependencies } = createRenderify({
    llm: new StaticPlanLLM(),
  });

  assert.ok(app);
  assert.equal(typeof app.start, "function");
  assert.ok(dependencies.runtime);
  assert.ok(dependencies.security);

  await app.start();
  try {
    const result = await app.renderPrompt("hello");
    assert.equal(result.plan.id, "llm-plan");
    assert.match(result.html, /Hello from LLM/);
  } finally {
    await app.stop();
  }
});

test("renderify facade one-shot helpers renderPromptOnce and renderPlanOnce", async () => {
  const promptResult = await renderPromptOnce("hello", {
    llm: new StaticPlanLLM(),
  });
  assert.equal(promptResult.plan.id, "llm-plan");
  assert.match(promptResult.html, /Hello from LLM/);

  const plan: RuntimePlan = {
    specVersion: "runtime-plan/v1",
    id: "manual-plan",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "Manual plan" }],
    },
  };

  const planResult = await renderPlanOnce(plan, {
    llm: new StaticPlanLLM(),
  });

  assert.equal(planResult.plan.id, "manual-plan");
  assert.match(planResult.html, /Manual plan/);
});
