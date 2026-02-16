import type { RuntimeExecutionResult, RuntimePlan } from "@renderify/ir";
import type { RuntimeExecutionInput, RuntimeManager } from "@renderify/runtime";
import type { ApiIntegration } from "./api-integration";
import type {
  CodeGenerationInput,
  CodeGenerator,
  IncrementalCodeGenerationSession,
} from "./codegen";
import type { RenderifyConfig } from "./config";
import type { ContextManager } from "./context";
import type {
  CustomizationEngine,
  PluginContext,
  PluginHook,
} from "./customization";
import type {
  LLMInterpreter,
  LLMResponse,
  LLMResponseStreamChunk,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "./llm-interpreter";
import type { PerformanceOptimizer } from "./performance";
import type {
  RuntimeSecurityPolicy,
  RuntimeSecurityProfile,
  SecurityChecker,
  SecurityCheckResult,
} from "./security";
import type { RenderTarget, UIRenderer } from "./ui";

export interface RenderifyCoreDependencies {
  config: RenderifyConfig;
  context: ContextManager;
  llm: LLMInterpreter;
  codegen: CodeGenerator;
  runtime: RuntimeManager;
  security: SecurityChecker;
  performance: PerformanceOptimizer;
  ui: UIRenderer;
  apiIntegration?: ApiIntegration;
  customization?: CustomizationEngine;
}

export interface RenderPromptOptions {
  target?: RenderTarget;
  traceId?: string;
  signal?: AbortSignal;
}

export interface RenderPlanOptions {
  target?: RenderTarget;
  traceId?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface RenderPlanResult {
  traceId: string;
  plan: RuntimePlan;
  security: SecurityCheckResult;
  execution: RuntimeExecutionResult;
  html: string;
}

export interface RenderPromptResult extends RenderPlanResult {
  prompt: string;
  llm: LLMResponse;
}

export interface RenderPromptStreamOptions extends RenderPromptOptions {
  previewEveryChunks?: number;
}

export interface RenderPromptStreamChunk {
  type: "llm-delta" | "preview" | "final" | "error";
  traceId: string;
  prompt: string;
  llmText: string;
  delta?: string;
  html?: string;
  diagnostics?: RuntimeExecutionResult["diagnostics"];
  planId?: string;
  final?: RenderPromptResult;
  error?: {
    message: string;
    name?: string;
  };
}

interface ExecutePlanFlowParams {
  traceId: string;
  metricLabel: string;
  plan: RuntimePlan;
  target?: RenderTarget;
  prompt?: string;
  signal?: AbortSignal;
}

type EventCallback = (...args: unknown[]) => void;

export class PolicyRejectionError extends Error {
  readonly result: SecurityCheckResult;

  constructor(result: SecurityCheckResult) {
    super(`Security policy rejected runtime plan: ${result.issues.join("; ")}`);
    this.name = "PolicyRejectionError";
    this.result = result;
  }
}

export class RenderifyApp {
  private readonly deps: RenderifyCoreDependencies;
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private running = false;

  constructor(deps: RenderifyCoreDependencies) {
    this.deps = deps;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.deps.config.load();
    this.deps.llm.configure(this.deps.config.snapshot());
    await this.deps.context.initialize();

    const policyOverrides =
      this.deps.config.get<Partial<RuntimeSecurityPolicy>>("securityPolicy");
    const securityProfile =
      this.deps.config.get<RuntimeSecurityProfile>("securityProfile");
    this.deps.security.initialize({
      profile: securityProfile,
      overrides: policyOverrides,
    });

    await this.deps.runtime.initialize();

    this.running = true;
    this.emit("started");
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    await this.deps.runtime.terminate();
    this.running = false;
    this.emit("stopped");
  }

  public async renderPrompt(
    prompt: string,
    options: RenderPromptOptions = {},
  ): Promise<RenderPromptResult> {
    this.ensureRunning();
    this.throwIfAborted(options.signal);

    const traceId = options.traceId ?? this.createTraceId();
    const metricLabel = this.createMetricLabel(traceId);
    this.deps.performance.startMeasurement(metricLabel);

    let llmResponse: LLMResponse | undefined;
    let promptAfterHook = prompt;
    let handoffToPlanFlow = false;

    try {
      const pluginContextFactory = (hookName: PluginHook): PluginContext => ({
        traceId,
        hookName,
      });

      promptAfterHook = await this.runHook(
        "beforeLLM",
        prompt,
        pluginContextFactory("beforeLLM"),
      );

      const llmContext = this.toRecord(this.deps.context.getContext());
      const llmRequestBase = {
        prompt: promptAfterHook,
        context: llmContext,
        signal: options.signal,
      };
      const llmUseStructuredOutput =
        this.deps.config.get<boolean>("llmUseStructuredOutput") !== false;

      let llmStructuredResponse: LLMStructuredResponse<unknown> | undefined;
      let llmResponseRaw: LLMResponse;

      if (
        llmUseStructuredOutput &&
        typeof this.deps.llm.generateStructuredResponse === "function"
      ) {
        const structuredRequest: LLMStructuredRequest = {
          ...llmRequestBase,
          format: "runtime-plan",
          strict: true,
        };

        llmStructuredResponse =
          await this.deps.llm.generateStructuredResponse(structuredRequest);
        const structuredErrors = [...(llmStructuredResponse.errors ?? [])];

        if (!llmStructuredResponse.valid) {
          const retryHint =
            structuredErrors.length > 0
              ? structuredErrors.join("; ")
              : "response did not pass RuntimePlan validation";
          const retryRequest: LLMStructuredRequest = {
            ...structuredRequest,
            prompt: `${promptAfterHook}\n\nPrevious structured response was invalid: ${retryHint}\nReturn corrected RuntimePlan JSON only. No markdown.`,
          };
          const retryStructuredResponse =
            await this.deps.llm.generateStructuredResponse(retryRequest);
          structuredErrors.push(...(retryStructuredResponse.errors ?? []));
          llmStructuredResponse = {
            ...retryStructuredResponse,
            errors: structuredErrors,
          };
        }

        if (
          llmStructuredResponse.valid &&
          llmStructuredResponse.text.trim().length > 0
        ) {
          llmResponseRaw = {
            text: llmStructuredResponse.text,
            tokensUsed: llmStructuredResponse.tokensUsed,
            model: llmStructuredResponse.model,
            raw: {
              mode: "structured",
              value: llmStructuredResponse.value,
              errors: llmStructuredResponse.errors,
              payload: llmStructuredResponse.raw,
            },
          };
        } else {
          const fallbackResponse =
            await this.deps.llm.generateResponse(llmRequestBase);
          llmResponseRaw = {
            ...fallbackResponse,
            raw: {
              mode: "fallback-text",
              structuredErrors: llmStructuredResponse.errors ?? [],
              fallbackPayload: fallbackResponse.raw,
            },
          };
        }
      } else {
        llmResponseRaw = await this.deps.llm.generateResponse(llmRequestBase);
      }

      llmResponse = await this.runHook(
        "afterLLM",
        llmResponseRaw,
        pluginContextFactory("afterLLM"),
      );

      const codegenInputRaw: CodeGenerationInput = {
        prompt: promptAfterHook,
        llmText: llmResponse.text,
        context: llmContext,
      };

      const codegenInput = await this.runHook(
        "beforeCodeGen",
        codegenInputRaw,
        pluginContextFactory("beforeCodeGen"),
      );

      const planned = await this.deps.codegen.generatePlan(codegenInput);

      const planAfterCodegen = await this.runHook(
        "afterCodeGen",
        planned,
        pluginContextFactory("afterCodeGen"),
      );

      handoffToPlanFlow = true;

      const planFlowResult = await this.executePlanFlow({
        traceId,
        metricLabel,
        prompt: promptAfterHook,
        plan: planAfterCodegen,
        target: options.target,
        signal: options.signal,
      });

      return {
        ...planFlowResult,
        prompt: promptAfterHook,
        llm: llmResponse,
      };
    } catch (error) {
      if (!handoffToPlanFlow) {
        const metric = this.deps.performance.endMeasurement(metricLabel);
        this.emit("renderFailed", { traceId, metric, error });
      }

      throw error;
    }
  }

  public async *renderPromptStream(
    prompt: string,
    options: RenderPromptStreamOptions = {},
  ): AsyncGenerator<RenderPromptStreamChunk, RenderPromptResult> {
    this.ensureRunning();
    this.throwIfAborted(options.signal);

    const traceId = options.traceId ?? this.createTraceId();
    const metricLabel = this.createMetricLabel(traceId);
    this.deps.performance.startMeasurement(metricLabel);

    let promptAfterHook = prompt;
    let handoffToPlanFlow = false;
    let llmResponse: LLMResponse | undefined;

    try {
      const pluginContextFactory = (hookName: PluginHook): PluginContext => ({
        traceId,
        hookName,
      });

      promptAfterHook = await this.runHook(
        "beforeLLM",
        prompt,
        pluginContextFactory("beforeLLM"),
      );

      const llmContext = this.toRecord(this.deps.context.getContext());
      const llmRequestBase = {
        prompt: promptAfterHook,
        context: llmContext,
        signal: options.signal,
      };
      const incrementalCodegenSession:
        | IncrementalCodeGenerationSession
        | undefined =
        typeof this.deps.codegen.createIncrementalSession === "function"
          ? this.deps.codegen.createIncrementalSession({
              prompt: promptAfterHook,
              context: llmContext,
            })
          : undefined;
      const llmUseStructuredOutput =
        this.deps.config.get<boolean>("llmUseStructuredOutput") !== false;

      const streamPreviewInterval = Math.max(
        1,
        Math.floor(options.previewEveryChunks ?? 2),
      );
      const buildPreviewChunk = async (
        llmText: string,
        delta?: string,
      ): Promise<RenderPromptStreamChunk | undefined> => {
        const preview = await this.buildStreamingPreview(
          promptAfterHook,
          llmText,
          llmContext,
          options.target,
          incrementalCodegenSession,
          delta,
          options.signal,
        );
        if (!preview) {
          return undefined;
        }

        return {
          type: "preview",
          traceId,
          prompt: promptAfterHook,
          llmText,
          html: preview.html,
          diagnostics: preview.execution.diagnostics,
          planId: preview.plan.id,
        };
      };

      if (
        llmUseStructuredOutput &&
        typeof this.deps.llm.generateStructuredResponse === "function"
      ) {
        const structuredRequest: LLMStructuredRequest = {
          ...llmRequestBase,
          format: "runtime-plan",
          strict: true,
        };

        let structuredResponse =
          await this.deps.llm.generateStructuredResponse(structuredRequest);
        const structuredErrors = [...(structuredResponse.errors ?? [])];

        if (!structuredResponse.valid) {
          const retryHint =
            structuredErrors.length > 0
              ? structuredErrors.join("; ")
              : "response did not pass RuntimePlan validation";
          const retryRequest: LLMStructuredRequest = {
            ...structuredRequest,
            prompt: `${promptAfterHook}\n\nPrevious structured response was invalid: ${retryHint}\nReturn corrected RuntimePlan JSON only. No markdown.`,
          };
          const retryStructuredResponse =
            await this.deps.llm.generateStructuredResponse(retryRequest);
          structuredErrors.push(...(retryStructuredResponse.errors ?? []));
          structuredResponse = {
            ...retryStructuredResponse,
            errors: structuredErrors,
          };
        }

        if (
          structuredResponse.valid &&
          structuredResponse.text.trim().length > 0
        ) {
          const fullText = structuredResponse.text;
          const chunkSize = Math.max(256, Math.floor(fullText.length / 4));
          let latestText = "";

          for (let offset = 0; offset < fullText.length; offset += chunkSize) {
            const delta = fullText.slice(offset, offset + chunkSize);
            latestText += delta;
            const done = latestText.length >= fullText.length;

            yield {
              type: "llm-delta",
              traceId,
              prompt: promptAfterHook,
              llmText: latestText,
              delta,
            };

            if (done) {
              const previewChunk = await buildPreviewChunk(latestText, delta);
              if (previewChunk) {
                yield previewChunk;
              }
            }
          }

          llmResponse = {
            text: fullText,
            tokensUsed: structuredResponse.tokensUsed ?? fullText.length,
            model: structuredResponse.model,
            raw: {
              mode: "structured",
              value: structuredResponse.value,
              errors: structuredResponse.errors,
              payload: structuredResponse.raw,
            },
          };
        } else {
          let fallbackRaw: LLMResponse;

          if (typeof this.deps.llm.generateResponseStream === "function") {
            let latestText = "";
            let latestChunk: LLMResponseStreamChunk | undefined;
            let chunkCount = 0;

            for await (const chunk of this.deps.llm.generateResponseStream(
              llmRequestBase,
            )) {
              this.throwIfAborted(options.signal);
              chunkCount += 1;
              latestChunk = chunk;
              latestText = chunk.text;

              yield {
                type: "llm-delta",
                traceId,
                prompt: promptAfterHook,
                llmText: latestText,
                delta: chunk.delta,
              };

              if (chunk.done || chunkCount % streamPreviewInterval === 0) {
                const previewChunk = await buildPreviewChunk(
                  latestText,
                  chunk.delta,
                );
                if (previewChunk) {
                  yield previewChunk;
                }
              }
            }

            fallbackRaw = {
              text: latestText,
              tokensUsed: latestChunk?.tokensUsed ?? latestText.length,
              model: latestChunk?.model,
              raw: {
                mode: "stream",
                source: latestChunk?.raw,
              },
            };
          } else {
            fallbackRaw = await this.deps.llm.generateResponse(llmRequestBase);
            yield {
              type: "llm-delta",
              traceId,
              prompt: promptAfterHook,
              llmText: fallbackRaw.text,
              delta: fallbackRaw.text,
            };
          }

          llmResponse = {
            ...fallbackRaw,
            raw: {
              mode: "fallback-text",
              structuredErrors: structuredResponse.errors ?? [],
              fallbackPayload: fallbackRaw.raw,
            },
          };
        }
      } else if (typeof this.deps.llm.generateResponseStream === "function") {
        let latestText = "";
        let latestChunk: LLMResponseStreamChunk | undefined;
        let chunkCount = 0;

        for await (const chunk of this.deps.llm.generateResponseStream(
          llmRequestBase,
        )) {
          this.throwIfAborted(options.signal);
          chunkCount += 1;
          latestChunk = chunk;
          latestText = chunk.text;

          yield {
            type: "llm-delta",
            traceId,
            prompt: promptAfterHook,
            llmText: latestText,
            delta: chunk.delta,
          };

          if (chunk.done || chunkCount % streamPreviewInterval === 0) {
            const previewChunk = await buildPreviewChunk(
              latestText,
              chunk.delta,
            );
            if (previewChunk) {
              yield previewChunk;
            }
          }
        }

        llmResponse = {
          text: latestText,
          tokensUsed: latestChunk?.tokensUsed ?? latestText.length,
          model: latestChunk?.model,
          raw: {
            mode: "stream",
            source: latestChunk?.raw,
          },
        };
      } else {
        llmResponse = await this.deps.llm.generateResponse(llmRequestBase);
        yield {
          type: "llm-delta",
          traceId,
          prompt: promptAfterHook,
          llmText: llmResponse.text,
          delta: llmResponse.text,
        };
      }

      llmResponse = await this.runHook(
        "afterLLM",
        llmResponse,
        pluginContextFactory("afterLLM"),
      );

      const codegenInputRaw: CodeGenerationInput = {
        prompt: promptAfterHook,
        llmText: llmResponse.text,
        context: llmContext,
      };

      const codegenInput = await this.runHook(
        "beforeCodeGen",
        codegenInputRaw,
        pluginContextFactory("beforeCodeGen"),
      );

      const planned =
        (await incrementalCodegenSession?.finalize(llmResponse.text)) ??
        (await this.deps.codegen.generatePlan(codegenInput));
      const planAfterCodegen = await this.runHook(
        "afterCodeGen",
        planned,
        pluginContextFactory("afterCodeGen"),
      );

      handoffToPlanFlow = true;

      const planFlowResult = await this.executePlanFlow({
        traceId,
        metricLabel,
        prompt: promptAfterHook,
        plan: planAfterCodegen,
        target: options.target,
        signal: options.signal,
      });

      const final: RenderPromptResult = {
        ...planFlowResult,
        prompt: promptAfterHook,
        llm: llmResponse,
      };

      yield {
        type: "final",
        traceId,
        prompt: promptAfterHook,
        llmText: llmResponse.text,
        html: final.html,
        diagnostics: final.execution.diagnostics,
        planId: final.plan.id,
        final,
      };

      return final;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : undefined;

      yield {
        type: "error",
        traceId,
        prompt: promptAfterHook,
        llmText: llmResponse?.text ?? "",
        error: {
          message: errorMessage,
          ...(errorName ? { name: errorName } : {}),
        },
      };

      if (!handoffToPlanFlow) {
        const metric = this.deps.performance.endMeasurement(metricLabel);
        this.emit("renderFailed", { traceId, metric, error });
      }

      throw error;
    }
  }

  public async renderPlan(
    plan: RuntimePlan,
    options: RenderPlanOptions = {},
  ): Promise<RenderPlanResult> {
    this.ensureRunning();

    const traceId = options.traceId ?? this.createTraceId();
    const metricLabel = this.createMetricLabel(traceId);
    this.deps.performance.startMeasurement(metricLabel);

    return this.executePlanFlow({
      traceId,
      metricLabel,
      prompt: options.prompt,
      plan,
      target: options.target,
      signal: options.signal,
    });
  }

  public getConfig() {
    return this.deps.config;
  }

  public getContext() {
    return this.deps.context;
  }

  public getLLM() {
    return this.deps.llm;
  }

  public getCodeGenerator() {
    return this.deps.codegen;
  }

  public getRuntimeManager() {
    return this.deps.runtime;
  }

  public getSecurityChecker() {
    return this.deps.security;
  }

  public on(eventName: string, callback: EventCallback): () => void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }

    this.listeners.get(eventName)?.add(callback);

    return () => {
      this.listeners.get(eventName)?.delete(callback);
    };
  }

  public emit(eventName: string, payload?: unknown) {
    const callbacks = this.listeners.get(eventName);
    if (!callbacks) {
      return;
    }

    for (const callback of callbacks) {
      callback(payload);
    }
  }

  private async executePlanFlow(
    params: ExecutePlanFlowParams,
  ): Promise<RenderPlanResult> {
    const { traceId, metricLabel, prompt, plan, target, signal } = params;
    this.throwIfAborted(signal);

    try {
      const pluginContextFactory = (hookName: PluginHook): PluginContext => ({
        traceId,
        hookName,
      });

      const planBeforePolicy = await this.runHook(
        "beforePolicyCheck",
        plan,
        pluginContextFactory("beforePolicyCheck"),
      );

      const securityResultRaw =
        await this.deps.security.checkPlan(planBeforePolicy);
      const securityResult = await this.runHook(
        "afterPolicyCheck",
        securityResultRaw,
        pluginContextFactory("afterPolicyCheck"),
      );

      if (!securityResult.safe) {
        this.emit("policyRejected", securityResult);
        throw new PolicyRejectionError(securityResult);
      }

      const runtimeInputRaw: RuntimeExecutionInput = {
        plan: planBeforePolicy,
        context: {
          userId: this.resolveUserId(),
          variables: {},
        },
        signal,
      };

      const runtimeInput = await this.runHook(
        "beforeRuntime",
        runtimeInputRaw,
        pluginContextFactory("beforeRuntime"),
      );

      const runtimeExecutionRaw = await this.deps.runtime.execute(runtimeInput);

      const runtimeExecution = await this.runHook(
        "afterRuntime",
        runtimeExecutionRaw,
        pluginContextFactory("afterRuntime"),
      );

      const renderInput = await this.runHook(
        "beforeRender",
        runtimeExecution,
        pluginContextFactory("beforeRender"),
      );

      const htmlRaw = await this.deps.ui.render(renderInput, target);
      this.throwIfAborted(signal);

      const html = await this.runHook(
        "afterRender",
        htmlRaw,
        pluginContextFactory("afterRender"),
      );

      const metric = this.deps.performance.endMeasurement(metricLabel);
      this.emit("rendered", {
        traceId,
        metric,
        prompt,
        planId: planBeforePolicy.id,
      });

      return {
        traceId,
        plan: planBeforePolicy,
        security: securityResult,
        execution: runtimeExecution,
        html,
      };
    } catch (error) {
      const metric = this.deps.performance.endMeasurement(metricLabel);
      this.emit("renderFailed", { traceId, metric, prompt, error });
      throw error;
    }
  }

  private ensureRunning(): void {
    if (!this.running) {
      throw new Error("RenderifyApp is not started");
    }
  }

  private async runHook<Payload>(
    hookName: PluginHook,
    payload: Payload,
    context: PluginContext,
  ): Promise<Payload> {
    if (!this.deps.customization) {
      return payload;
    }

    return this.deps.customization.runHook(hookName, payload, context);
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private createTraceId(): string {
    return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private createMetricLabel(traceId: string): string {
    return `pipeline:${traceId}`;
  }

  private resolveUserId(): string {
    const candidate = this.deps.context.getContext().user?.id;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    return "anonymous";
  }

  private async buildStreamingPreview(
    prompt: string,
    llmText: string,
    context: Record<string, unknown>,
    target?: RenderTarget,
    incrementalCodegenSession?: IncrementalCodeGenerationSession,
    delta?: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        plan: RuntimePlan;
        execution: RuntimeExecutionResult;
        html: string;
      }
    | undefined
  > {
    try {
      this.throwIfAborted(signal);
      let plan: RuntimePlan | undefined;

      if (incrementalCodegenSession) {
        if (typeof delta === "string" && delta.length > 0) {
          const incrementalUpdate =
            await incrementalCodegenSession.pushDelta(delta);
          if (!incrementalUpdate) {
            return undefined;
          }

          // Suppress noisy text-fallback previews while streaming;
          // only render previews when a structured/source candidate emerges.
          if (incrementalUpdate.mode === "runtime-text-fallback") {
            return undefined;
          }

          plan = incrementalUpdate.plan;
        }

        if (!plan) {
          return undefined;
        }
      } else {
        plan = await this.deps.codegen.generatePlan({
          prompt,
          llmText,
          context,
        });
      }

      const security = await this.deps.security.checkPlan(plan);
      if (!security.safe) {
        return undefined;
      }

      const execution = await this.deps.runtime.execute({
        plan,
        context: {
          userId: this.resolveUserId(),
          variables: {},
        },
        signal,
      });
      const html = await this.deps.ui.render(execution, target);

      return {
        plan,
        execution,
        html,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      return undefined;
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Renderify request aborted");
    error.name = "AbortError";
    throw error;
  }
}

export function createRenderifyApp(
  deps: RenderifyCoreDependencies,
): RenderifyApp {
  return new RenderifyApp(deps);
}

export * from "./api-integration";
export * from "./codegen";
export * from "./config";
export * from "./context";
export * from "./customization";
export * from "./framework-adapters";
export * from "./llm-interpreter";
export * from "./performance";
export * from "./security";
export * from "./ui";
