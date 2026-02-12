import { DefaultCodeGenerator } from "@renderify/codegen";
import { DefaultRenderifyConfig } from "@renderify/config";
import {
  createRenderifyApp,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
} from "@renderify/core";
import { DefaultLLMInterpreter } from "@renderify/llm-interpreter";
import { DefaultRuntimeManager } from "@renderify/runtime";
import { JspmModuleLoader } from "@renderify/runtime-jspm";
import { DefaultSecurityChecker } from "@renderify/security";
import { DefaultUIRenderer } from "@renderify/ui";

async function main() {
  const app = createRenderifyApp({
    config: new DefaultRenderifyConfig(),
    context: new DefaultContextManager(),
    llm: new DefaultLLMInterpreter(),
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
