import type { ApiIntegration } from "@renderify/api-integration";
import type {
  CodeGenerationInput,
  CodeGenerator,
  IncrementalCodeGenerationSession,
} from "@renderify/codegen";
import type { RenderifyConfig } from "@renderify/config";
import type { ContextManager } from "@renderify/context";
import type {
  CustomizationEngine,
  PluginContext,
  PluginHook,
} from "@renderify/customization";
import type {
  RuntimeEvent,
  RuntimeExecutionResult,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import type {
  LLMInterpreter,
  LLMResponse,
  LLMResponseStreamChunk,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "@renderify/llm-interpreter";
import type { PerformanceOptimizer } from "@renderify/performance";
import type { RuntimeExecutionInput, RuntimeManager } from "@renderify/runtime";
import type {
  RuntimeSecurityPolicy,
  RuntimeSecurityProfile,
  SecurityChecker,
  SecurityCheckResult,
} from "@renderify/security";
import type { RenderTarget, UIRenderer } from "@renderify/ui";
import {
  type ExecutionAuditLog,
  type ExecutionAuditRecord,
  type ExecutionMode,
  type ExecutionStatus,
  InMemoryExecutionAuditLog,
} from "./audit-log";
import {
  InMemoryPlanRegistry,
  type PlanRegistry,
  type PlanSummary,
  type PlanVersionRecord,
} from "./plan-registry";
import {
  InMemoryTenantGovernor,
  type TenantGovernor,
  type TenantLease,
  TenantQuotaExceededError,
  type TenantQuotaPolicy,
} from "./tenant-governor";

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
  planRegistry?: PlanRegistry;
  auditLog?: ExecutionAuditLog;
  tenantGovernor?: TenantGovernor;
}

export interface RenderPromptOptions {
  target?: RenderTarget;
  traceId?: string;
}

export interface RenderPlanOptions {
  target?: RenderTarget;
  traceId?: string;
  mode?: ExecutionMode;
  prompt?: string;
  event?: RuntimeEvent;
  stateOverride?: RuntimeStateSnapshot;
}

export interface RenderPlanResult {
  traceId: string;
  plan: RuntimePlan;
  security: SecurityCheckResult;
  execution: RuntimeExecutionResult;
  html: string;
  audit: ExecutionAuditRecord;
}

export interface RenderPromptResult extends RenderPlanResult {
  prompt: string;
  llm: LLMResponse;
}

export interface RenderPromptStreamOptions extends RenderPromptOptions {
  previewEveryChunks?: number;
}

export interface RenderPromptStreamChunk {
  type: "llm-delta" | "preview" | "final";
  traceId: string;
  prompt: string;
  llmText: string;
  delta?: string;
  html?: string;
  diagnostics?: RuntimeExecutionResult["diagnostics"];
  planId?: string;
  final?: RenderPromptResult;
}

interface ExecutePlanFlowParams {
  traceId: string;
  metricLabel: string;
  startedAt: number;
  mode: ExecutionMode;
  plan: RuntimePlan;
  target?: RenderTarget;
  prompt?: string;
  event?: RuntimeEvent;
  stateOverride?: RuntimeStateSnapshot;
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
  private readonly planRegistry: PlanRegistry;
  private readonly auditLog: ExecutionAuditLog;
  private readonly tenantGovernor: TenantGovernor;
  private running = false;

  constructor(deps: RenderifyCoreDependencies) {
    this.deps = deps;
    this.planRegistry = deps.planRegistry ?? new InMemoryPlanRegistry();
    this.auditLog = deps.auditLog ?? new InMemoryExecutionAuditLog();
    this.tenantGovernor = deps.tenantGovernor ?? new InMemoryTenantGovernor();
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

    const tenantQuotaPolicy =
      this.deps.config.get<Partial<TenantQuotaPolicy>>("tenantQuotaPolicy");
    this.tenantGovernor.initialize(tenantQuotaPolicy);

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

    const traceId = options.traceId ?? this.createTraceId();
    const metricLabel = this.createMetricLabel(traceId);
    const startedAt = Date.now();
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
        startedAt,
        mode: "prompt",
        prompt: promptAfterHook,
        plan: planAfterCodegen,
        target: options.target,
      });

      return {
        ...planFlowResult,
        prompt: promptAfterHook,
        llm: llmResponse,
      };
    } catch (error) {
      if (!handoffToPlanFlow) {
        const metric = this.deps.performance.endMeasurement(metricLabel);
        const audit = this.recordAudit({
          traceId,
          mode: "prompt",
          status: "failed",
          startedAt,
          prompt: promptAfterHook,
          tenantId: this.resolveTenantId(),
          plan: undefined,
          diagnosticsCount: 0,
          securityIssueCount: 0,
          errorMessage: this.errorToMessage(error),
        });
        this.emit("renderFailed", { traceId, metric, audit, error });
      }

      throw error;
    }
  }

  public async *renderPromptStream(
    prompt: string,
    options: RenderPromptStreamOptions = {},
  ): AsyncGenerator<RenderPromptStreamChunk, RenderPromptResult> {
    this.ensureRunning();

    const traceId = options.traceId ?? this.createTraceId();
    const metricLabel = this.createMetricLabel(traceId);
    const startedAt = Date.now();
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

        const structuredResponse =
          await this.deps.llm.generateStructuredResponse(structuredRequest);

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
        startedAt,
        mode: "prompt",
        prompt: promptAfterHook,
        plan: planAfterCodegen,
        target: options.target,
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
      if (!handoffToPlanFlow) {
        const metric = this.deps.performance.endMeasurement(metricLabel);
        const audit = this.recordAudit({
          traceId,
          mode: "prompt",
          status: "failed",
          startedAt,
          prompt: promptAfterHook,
          tenantId: this.resolveTenantId(),
          plan: undefined,
          diagnosticsCount: 0,
          securityIssueCount: 0,
          errorMessage: this.errorToMessage(error),
        });
        this.emit("renderFailed", { traceId, metric, audit, error });
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
    const startedAt = Date.now();
    this.deps.performance.startMeasurement(metricLabel);

    return this.executePlanFlow({
      traceId,
      metricLabel,
      startedAt,
      mode: options.mode ?? "plan",
      prompt: options.prompt,
      event: options.event,
      stateOverride: options.stateOverride,
      plan,
      target: options.target,
    });
  }

  public async dispatchEvent(
    planId: string,
    event: RuntimeEvent,
    options: Omit<RenderPlanOptions, "mode" | "event"> = {},
  ): Promise<RenderPlanResult> {
    const record = this.planRegistry.get(planId);
    if (!record) {
      throw new Error(`Plan ${planId} not found`);
    }

    return this.renderPlan(record.plan, {
      ...options,
      mode: "event",
      event,
      prompt: options.prompt ?? `event:${event.type}`,
    });
  }

  public async rollbackPlan(
    planId: string,
    version: number,
    options: Omit<RenderPlanOptions, "mode"> = {},
  ): Promise<RenderPlanResult> {
    const record = this.planRegistry.get(planId, version);
    if (!record) {
      throw new Error(`Plan ${planId}@${version} not found`);
    }

    this.deps.runtime.clearPlanState(planId);

    return this.renderPlan(record.plan, {
      ...options,
      mode: "rollback",
      prompt: options.prompt ?? `rollback:${planId}@${version}`,
    });
  }

  public async replayTrace(
    traceId: string,
    options: Omit<RenderPlanOptions, "mode"> = {},
  ): Promise<RenderPlanResult> {
    const audit = this.auditLog.get(traceId);
    if (!audit || !audit.planId || audit.planVersion === undefined) {
      throw new Error(`Replay source trace ${traceId} not found`);
    }

    const record = this.planRegistry.get(audit.planId, audit.planVersion);
    if (!record) {
      throw new Error(
        `Replay source plan ${audit.planId}@${audit.planVersion} not found`,
      );
    }

    return this.renderPlan(record.plan, {
      ...options,
      mode: "replay",
      prompt: audit.prompt,
      event: audit.event,
    });
  }

  public listPlans(): PlanSummary[] {
    return this.planRegistry.list();
  }

  public listPlanVersions(planId: string): PlanVersionRecord[] {
    return this.planRegistry.listVersions(planId);
  }

  public getPlan(
    planId: string,
    version?: number,
  ): PlanVersionRecord | undefined {
    return this.planRegistry.get(planId, version);
  }

  public getPlanState(planId: string): RuntimeStateSnapshot | undefined {
    return this.deps.runtime.getPlanState(planId);
  }

  public setPlanState(planId: string, state: RuntimeStateSnapshot): void {
    this.deps.runtime.setPlanState(planId, state);
  }

  public listAudits(limit?: number): ExecutionAuditRecord[] {
    return this.auditLog.list(limit);
  }

  public getAudit(traceId: string): ExecutionAuditRecord | undefined {
    return this.auditLog.get(traceId);
  }

  public clearHistory(): void {
    for (const plan of this.planRegistry.list()) {
      this.deps.runtime.clearPlanState(plan.planId);
    }

    this.planRegistry.clear();
    this.auditLog.clear();
    this.tenantGovernor.reset();
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

  public getSecurityChecker() {
    return this.deps.security;
  }

  public getTenantGovernor() {
    return this.tenantGovernor;
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
    const {
      traceId,
      metricLabel,
      startedAt,
      mode,
      prompt,
      plan,
      target,
      event,
      stateOverride,
    } = params;

    let registeredPlan: RuntimePlan | undefined;
    let securityResult: SecurityCheckResult | undefined;
    let diagnosticsCount = 0;
    const tenantId = this.resolveTenantId();
    let tenantLease: TenantLease | undefined;

    try {
      const pluginContextFactory = (hookName: PluginHook): PluginContext => ({
        traceId,
        hookName,
      });

      registeredPlan = this.planRegistry.register(plan).plan;
      tenantLease = this.tenantGovernor.acquire(tenantId);

      const planBeforePolicy = await this.runHook(
        "beforePolicyCheck",
        registeredPlan,
        pluginContextFactory("beforePolicyCheck"),
      );

      const securityResultRaw = this.deps.security.checkPlan(planBeforePolicy);
      securityResult = await this.runHook(
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
        event,
        stateOverride,
        context: {
          userId: tenantId,
          variables: {},
        },
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

      diagnosticsCount = runtimeExecution.diagnostics.length;

      const renderInput = await this.runHook(
        "beforeRender",
        runtimeExecution,
        pluginContextFactory("beforeRender"),
      );

      const htmlRaw = await this.deps.ui.render(renderInput, target);

      const html = await this.runHook(
        "afterRender",
        htmlRaw,
        pluginContextFactory("afterRender"),
      );

      const metric = this.deps.performance.endMeasurement(metricLabel);

      const audit = this.recordAudit({
        traceId,
        mode,
        status: "succeeded",
        startedAt,
        prompt,
        tenantId,
        event,
        plan: planBeforePolicy,
        diagnosticsCount,
        securityIssueCount: 0,
      });

      this.emit("rendered", { traceId, metric, audit });
      tenantLease.release();

      return {
        traceId,
        plan: planBeforePolicy,
        security: securityResult,
        execution: runtimeExecution,
        html,
        audit,
      };
    } catch (error) {
      const metric = this.deps.performance.endMeasurement(metricLabel);

      const status: ExecutionStatus =
        error instanceof PolicyRejectionError
          ? "rejected"
          : error instanceof TenantQuotaExceededError
            ? "throttled"
            : "failed";

      const audit = this.recordAudit({
        traceId,
        mode,
        status,
        startedAt,
        prompt,
        tenantId,
        event,
        plan: registeredPlan,
        diagnosticsCount,
        securityIssueCount:
          error instanceof PolicyRejectionError
            ? error.result.issues.length
            : (securityResult?.issues.length ?? 0),
        errorMessage: this.errorToMessage(error),
      });

      this.emit("renderFailed", { traceId, metric, audit, error });
      tenantLease?.release();
      throw error;
    }
  }

  private recordAudit(input: {
    traceId: string;
    mode: ExecutionMode;
    status: ExecutionStatus;
    startedAt: number;
    prompt?: string;
    tenantId?: string;
    event?: RuntimeEvent;
    plan?: RuntimePlan;
    diagnosticsCount: number;
    securityIssueCount: number;
    errorMessage?: string;
  }): ExecutionAuditRecord {
    const completedAt = Date.now();
    const record: ExecutionAuditRecord = {
      traceId: input.traceId,
      mode: input.mode,
      status: input.status,
      startedAt: input.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - input.startedAt),
      prompt: input.prompt,
      tenantId: input.tenantId,
      planId: input.plan?.id,
      planVersion: input.plan?.version,
      diagnosticsCount: input.diagnosticsCount,
      securityIssueCount: input.securityIssueCount,
      event: input.event,
      errorMessage: input.errorMessage,
    };

    this.auditLog.append(record);
    return record;
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

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private resolveTenantId(): string {
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
  ): Promise<
    | {
        plan: RuntimePlan;
        execution: RuntimeExecutionResult;
        html: string;
      }
    | undefined
  > {
    try {
      let plan: RuntimePlan | undefined;

      if (incrementalCodegenSession) {
        if (typeof delta === "string" && delta.length > 0) {
          const incrementalUpdate =
            await incrementalCodegenSession.pushDelta(delta);
          plan = incrementalUpdate?.plan;
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

      const security = this.deps.security.checkPlan(plan);
      if (!security.safe) {
        return undefined;
      }

      const execution = await this.deps.runtime.execute({
        plan,
        context: {
          userId: this.resolveTenantId(),
          variables: {},
        },
      });
      const html = await this.deps.ui.render(execution, target);
      this.deps.runtime.clearPlanState(plan.id);

      return {
        plan,
        execution,
        html,
      };
    } catch {
      return undefined;
    }
  }
}

export function createRenderifyApp(
  deps: RenderifyCoreDependencies,
): RenderifyApp {
  return new RenderifyApp(deps);
}

export * from "./audit-log";
export * from "./plan-registry";
export * from "./tenant-governor";
