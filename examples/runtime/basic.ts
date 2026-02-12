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
      text: `Build runtime card for: ${req.prompt}`,
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
              children: [{ type: "text", value: "Runtime render is ready." }],
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

  const promptResult = await app.renderPrompt(
    "Generate a runtime welcome card",
  );
  console.log("[prompt html]");
  console.log(promptResult.html);

  const planResult = await app.renderPlan(promptResult.plan, {
    prompt: "re-render structured plan",
  });
  console.log("[render-plan html]");
  console.log(planResult.html);

  await app.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
