import {
  type ApiIntegration,
  type CodeGenerator,
  type ContextManager,
  type CustomizationEngine,
  createRenderifyApp,
  DefaultApiIntegration,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultUIRenderer,
  type LLMInterpreter,
  type PerformanceOptimizer,
  type RenderifyApp,
  type RenderifyConfig,
  type RenderifyConfigValues,
  type RenderifyCoreDependencies,
  type RenderPlanOptions,
  type RenderPlanResult,
  type RenderPromptOptions,
  type RenderPromptResult,
  type UIRenderer,
} from "@renderify/core";
import type { RuntimePlan } from "@renderify/ir";
import {
  AnthropicLLMInterpreter,
  type AnthropicLLMInterpreterOptions,
  anthropicLLMProvider,
  createDefaultLLMProviderRegistry,
  createLLMInterpreter,
  defaultLLMProviderRegistry,
  GoogleLLMInterpreter,
  type GoogleLLMInterpreterOptions,
  googleLLMProvider,
  type LLMProviderDefinition,
  type LLMProviderName,
  LLMProviderRegistry,
  LMStudioLLMInterpreter,
  type LMStudioLLMInterpreterOptions,
  lmstudioLLMProvider,
  OllamaLLMInterpreter,
  type OllamaLLMInterpreterOptions,
  OpenAICodexLLMInterpreter,
  type OpenAICodexLLMInterpreterOptions,
  type OpenAICodexReasoningEffort,
  OpenAILLMInterpreter,
  type OpenAILLMInterpreterOptions,
  ollamaLLMProvider,
  openaiCodexLLMProvider,
  openaiLLMProvider,
} from "@renderify/llm";
import {
  createTrustedInteractiveSession,
  DefaultRuntimeManager,
  JspmModuleLoader,
  type JspmModuleLoaderOptions,
  type RuntimeManager,
  type RuntimeManagerOptions,
  renderPlanInBrowser,
  renderTrustedPlanInBrowser,
} from "@renderify/runtime";
import {
  DefaultSecurityChecker,
  type SecurityChecker,
} from "@renderify/security";

export * from "@renderify/core";
export type {
  AnthropicLLMInterpreterOptions,
  GoogleLLMInterpreterOptions,
  LLMProviderDefinition,
  LLMProviderName,
  LMStudioLLMInterpreterOptions,
  OllamaLLMInterpreterOptions,
  OpenAICodexLLMInterpreterOptions,
  OpenAICodexReasoningEffort,
  OpenAILLMInterpreterOptions,
};
export {
  AnthropicLLMInterpreter,
  anthropicLLMProvider,
  createDefaultLLMProviderRegistry,
  createLLMInterpreter,
  createTrustedInteractiveSession,
  defaultLLMProviderRegistry,
  GoogleLLMInterpreter,
  googleLLMProvider,
  LLMProviderRegistry,
  LMStudioLLMInterpreter,
  lmstudioLLMProvider,
  OllamaLLMInterpreter,
  OpenAICodexLLMInterpreter,
  OpenAILLMInterpreter,
  ollamaLLMProvider,
  openaiCodexLLMProvider,
  openaiLLMProvider,
  renderPlanInBrowser,
  renderTrustedPlanInBrowser,
};

export interface CreateRenderifyOptions {
  config?: RenderifyConfig;
  context?: ContextManager;
  llm?: LLMInterpreter;
  codegen?: CodeGenerator;
  runtime?: RuntimeManager;
  security?: SecurityChecker;
  performance?: PerformanceOptimizer;
  ui?: UIRenderer;
  apiIntegration?: ApiIntegration;
  customization?: CustomizationEngine;
  llmProvider?: string;
  llmProviderOptions?: Record<string, unknown>;
  moduleLoader?: JspmModuleLoader;
  moduleLoaderOptions?: JspmModuleLoaderOptions;
  runtimeOptions?: RuntimeManagerOptions;
}

export interface CreateRenderifyResult {
  app: RenderifyApp;
  dependencies: RenderifyCoreDependencies;
}

export interface RenderPromptOnceOptions extends CreateRenderifyOptions {
  render?: RenderPromptOptions;
}

export interface RenderPlanOnceOptions extends CreateRenderifyOptions {
  render?: RenderPlanOptions;
}

export function createRenderify(
  options: CreateRenderifyOptions = {},
): CreateRenderifyResult {
  const configLoadOverrides = createConfigLoadOverrides(options);
  const moduleLoader =
    options.moduleLoader ?? new JspmModuleLoader(options.moduleLoaderOptions);
  const dependencies: RenderifyCoreDependencies = {
    config: options.config ?? new DefaultRenderifyConfig(),
    ...(configLoadOverrides ? { configLoadOverrides } : {}),
    context: options.context ?? new DefaultContextManager(),
    llm:
      options.llm ??
      createLLMInterpreter({
        provider: options.llmProvider,
        providerOptions: options.llmProviderOptions,
      }),
    codegen: options.codegen ?? new DefaultCodeGenerator(),
    runtime:
      options.runtime ??
      new DefaultRuntimeManager({
        moduleLoader,
        ...(options.runtimeOptions ?? {}),
      }),
    runtimeOptionOverrides: options.runtime
      ? undefined
      : options.runtimeOptions,
    autoPinModuleLoader: moduleLoader,
    security: options.security ?? new DefaultSecurityChecker(),
    performance: options.performance ?? new DefaultPerformanceOptimizer(),
    ui: options.ui ?? new DefaultUIRenderer(),
    apiIntegration: options.apiIntegration ?? new DefaultApiIntegration(),
    customization: options.customization ?? new DefaultCustomizationEngine(),
  };

  return {
    app: createRenderifyApp(dependencies),
    dependencies,
  };
}

function createConfigLoadOverrides(
  options: CreateRenderifyOptions,
): Partial<RenderifyConfigValues> | undefined {
  if (options.llm) {
    return undefined;
  }

  const providerOptions = options.llmProviderOptions ?? {};
  const overrides: Record<string, unknown> = { ...providerOptions };
  if (typeof options.llmProvider === "string") {
    overrides.llmProvider = options.llmProvider;
  }

  applyConfigAlias(providerOptions, overrides, "model", "llmModel");
  applyConfigAlias(providerOptions, overrides, "baseUrl", "llmBaseUrl");
  applyConfigAlias(providerOptions, overrides, "apiKey", "llmApiKey");
  applyConfigAlias(
    providerOptions,
    overrides,
    "timeoutMs",
    "llmRequestTimeoutMs",
  );

  return Object.keys(overrides).length > 0
    ? (overrides as Partial<RenderifyConfigValues>)
    : undefined;
}

function applyConfigAlias(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: keyof RenderifyConfigValues,
): void {
  if (target[targetKey] !== undefined || source[sourceKey] === undefined) {
    return;
  }

  target[targetKey] = source[sourceKey];
}

export async function startRenderify(
  options: CreateRenderifyOptions = {},
): Promise<CreateRenderifyResult> {
  const created = createRenderify(options);
  await created.app.start();
  return created;
}

export async function renderPromptOnce(
  prompt: string,
  options: RenderPromptOnceOptions = {},
): Promise<RenderPromptResult> {
  const { render, ...createOptions } = options;
  const { app } = createRenderify(createOptions);

  await app.start();
  try {
    return await app.renderPrompt(prompt, render);
  } finally {
    await app.stop();
  }
}

export async function renderPlanOnce(
  plan: RuntimePlan,
  options: RenderPlanOnceOptions = {},
): Promise<RenderPlanResult> {
  const { render, ...createOptions } = options;
  const { app } = createRenderify(createOptions);

  await app.start();
  try {
    return await app.renderPlan(plan, render);
  } finally {
    await app.stop();
  }
}
