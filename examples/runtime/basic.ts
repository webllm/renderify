import {
  createRenderifyApp,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultSecurityChecker,
  DefaultUIRenderer,
  type LLMInterpreter,
  type LLMRequest,
  type LLMResponse,
  type LLMStructuredRequest,
  type LLMStructuredResponse,
} from "@renderify/core";
import { DefaultRuntimeManager, JspmModuleLoader } from "@renderify/runtime";

class DemoLLMInterpreter implements LLMInterpreter {
  configure(): void {}

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: `Build runtime counter for: ${req.prompt}`,
      model: "demo-llm",
    };
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    return {
      text: JSON.stringify({
        id: "basic_demo_plan",
        version: 1,
        capabilities: { domWrite: true },
        state: {
          initial: { count: 0 },
          transitions: {
            increment: [{ type: "increment", path: "count", by: 1 }],
          },
        },
        root: {
          type: "element",
          tag: "section",
          children: [
            {
              type: "element",
              tag: "h2",
              children: [{ type: "text", value: req.prompt }],
            },
            {
              type: "element",
              tag: "p",
              children: [{ type: "text", value: "Count={{state.count}}" }],
            },
          ],
        },
      }),
      valid: true,
      value: undefined as T,
      model: "demo-llm",
    };
  }

  setPromptTemplate(): void {}

  getPromptTemplate(): string | undefined {
    return undefined;
  }
}

async function main() {
  const app = createRenderifyApp({
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new DemoLLMInterpreter(),
    codegen: new DefaultCodeGenerator(),
    runtime: new DefaultRuntimeManager({
      moduleLoader: new JspmModuleLoader(),
    }),
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    customization: new DefaultCustomizationEngine(),
  });

  await app.start();

  const planResult = await app.renderPrompt(
    "Generate a runtime counter section",
  );
  console.log("[initial]");
  console.log(planResult.html);

  const eventResult = await app.dispatchEvent(planResult.plan.id, {
    type: "increment",
    payload: { delta: 1 },
  });

  console.log("[after event]");
  console.log(eventResult.html);
  console.log("[state]");
  console.log(app.getPlanState(planResult.plan.id));

  await app.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
