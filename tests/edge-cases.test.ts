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
} from "../packages/core/src/index";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import { DefaultRuntimeManager } from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";

class PlainLLM implements LLMInterpreter {
  configure(_options: Record<string, unknown>): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: [
        "{",
        '  "specVersion": "runtime-plan/v1",',
        '  "id": "edge_prompt_plan",',
        '  "version": 1,',
        '  "capabilities": { "domWrite": true },',
        '  "root": { "type": "text", "value": "' + req.prompt + '" }',
        "}",
      ].join("\n"),
    };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

function createApp() {
  return createRenderifyApp({
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new PlainLLM(),
    codegen: new DefaultCodeGenerator(),
    runtime: new DefaultRuntimeManager(),
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
  });
}

test("edge: renderPrompt throws before app.start", async () => {
  const app = createApp();

  await assert.rejects(
    () => app.renderPrompt("hello"),
    /RenderifyApp is not started/,
  );
});

test("edge: renderPlan throws after app.stop", async () => {
  const app = createApp();
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "edge_stop_plan",
    version: 1,
    capabilities: { domWrite: true },
    root: createElementNode("section", undefined, [createTextNode("ok")]),
  };

  await app.start();
  await app.stop();

  await assert.rejects(
    () => app.renderPlan(plan),
    /RenderifyApp is not started/,
  );
});

test("edge: start/stop are idempotent", async () => {
  const app = createApp();

  await app.start();
  await app.start();
  await app.stop();
  await app.stop();

  assert.ok(true);
});

test("edge: renderPrompt aborts immediately when signal is already aborted", async () => {
  const app = createApp();
  await app.start();

  try {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        app.renderPrompt("aborted", {
          signal: controller.signal,
        }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    await app.stop();
  }
});
