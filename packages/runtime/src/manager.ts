import {
  asJsonValue,
  cloneJsonValue,
  createElementNode,
  createTextNode,
  isRuntimeNode,
  type RuntimeAction,
  type RuntimeDiagnostic,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeExecutionProfile,
  type RuntimeExecutionResult,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimeRenderArtifact,
  type RuntimeSourceLanguage,
  type RuntimeSourceModule,
  type RuntimeStateSnapshot,
  resolveRuntimePlanSpecVersion,
} from "@renderify/ir";
import type {
  SecurityChecker,
  SecurityCheckResult,
  SecurityInitializationInput,
} from "@renderify/security";
import {
  buildRemoteModuleAttemptUrls,
  createCssProxyModuleSource,
  createJsonProxyModuleSource,
  createTextProxyModuleSource,
  createUrlProxyModuleSource,
  delay,
  extractJspmNpmSpecifier,
  fetchWithTimeout,
  isBinaryLikeContentType,
  isCssModuleResponse,
  isJavaScriptModuleResponse,
  isJsonModuleResponse,
  type RemoteModuleFetchResult,
  toConfiguredFallbackUrl,
  toEsmFallbackUrl,
} from "./module-fetch";
import { applyRuntimeAction } from "./runtime-actions";
import {
  hasExceededBudget as hasRuntimeExceededBudget,
  isAbortError as isRuntimeAbortError,
  isAborted as isRuntimeAborted,
  throwIfAborted as throwIfRuntimeAborted,
  withRemainingBudget as withRuntimeRemainingBudget,
} from "./runtime-budget";
import { createPreactRenderArtifact as createPreactRenderArtifactFromComponentRuntime } from "./runtime-component-runtime";
import {
  FALLBACK_ALLOW_ISOLATION_FALLBACK,
  FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED,
  FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS,
  FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT,
  FALLBACK_ENFORCE_MODULE_MANIFEST,
  FALLBACK_ESM_CDN_BASE,
  FALLBACK_EXECUTION_PROFILE,
  FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR,
  FALLBACK_JSPM_CDN_BASE,
  FALLBACK_MAX_COMPONENT_INVOCATIONS,
  FALLBACK_MAX_EXECUTION_MS,
  FALLBACK_MAX_IMPORTS,
  FALLBACK_REMOTE_FETCH_BACKOFF_MS,
  FALLBACK_REMOTE_FETCH_RETRIES,
  FALLBACK_REMOTE_FETCH_TIMEOUT_MS,
  normalizeFallbackCdnBases,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeSourceSandboxMode,
  normalizeSupportedSpecVersions,
} from "./runtime-defaults";
import { isBrowserRuntime, nowMs } from "./runtime-environment";
import {
  resolveRuntimeNode,
  selectExportFromNamespace,
} from "./runtime-node-resolver";
import {
  collectDependencyProbes,
  type DependencyProbe,
  executeDependencyProbe,
  type RuntimeDependencyProbeStatus,
  type RuntimeDependencyUsage,
  runDependencyPreflight,
} from "./runtime-preflight";
import {
  type RuntimeSourceSandboxMode as RuntimeSourceRuntimeMode,
  resolveSourceSandboxMode,
  shouldUsePreactSourceRuntime,
  transpileRuntimeSource,
} from "./runtime-source-runtime";
import {
  canMaterializeBrowserModules,
  createBrowserBlobModuleUrl,
  normalizeRuntimeSourceOutput,
  parseImportSpecifiersFromSource,
  revokeBrowserBlobUrls,
  rewriteImportsAsync,
} from "./runtime-source-utils";
import {
  isHttpUrl,
  resolveRuntimeSourceSpecifier,
  resolveRuntimeSpecifier,
  resolveSourceImportLoaderCandidate,
} from "./runtime-specifier";
import {
  executeSourceInBrowserSandbox,
  type RuntimeSandboxRequest,
} from "./sandbox";
import { BabelRuntimeSourceTranspiler } from "./transpiler";
import type { RenderTarget, UIRenderer } from "./ui-renderer";

export interface CompileOptions {
  pretty?: boolean;
}

export interface RuntimeModuleLoader {
  load(specifier: string): Promise<unknown>;
  unload?(specifier: string): Promise<void>;
}

export interface RuntimeExecutionInput {
  plan: RuntimePlan;
  context?: RuntimeExecutionContext;
  event?: RuntimeEvent;
  stateOverride?: RuntimeStateSnapshot;
  signal?: AbortSignal;
}

export type {
  RuntimeDependencyProbeStatus,
  RuntimeDependencyUsage,
} from "./runtime-preflight";

export interface RuntimePlanProbeResult {
  planId: string;
  diagnostics: RuntimeDiagnostic[];
  dependencies: RuntimeDependencyProbeStatus[];
}

export interface RuntimeManager {
  initialize(): Promise<void>;
  terminate(): Promise<void>;
  probePlan(plan: RuntimePlan): Promise<RuntimePlanProbeResult>;
  executePlan(
    plan: RuntimePlan,
    context?: RuntimeExecutionContext,
    event?: RuntimeEvent,
    stateOverride?: RuntimeStateSnapshot,
    signal?: AbortSignal,
  ): Promise<RuntimeExecutionResult>;
  execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult>;
  compile(plan: RuntimePlan, options?: CompileOptions): Promise<string>;
  getPlanState(planId: string): RuntimeStateSnapshot | undefined;
  setPlanState(planId: string, snapshot: RuntimeStateSnapshot): void;
  clearPlanState(planId: string): void;
}

export interface RuntimeManagerOptions {
  moduleLoader?: RuntimeModuleLoader;
  sourceTranspiler?: RuntimeSourceTranspiler;
  defaultMaxImports?: number;
  defaultMaxComponentInvocations?: number;
  defaultMaxExecutionMs?: number;
  defaultExecutionProfile?: RuntimeExecutionProfile;
  supportedPlanSpecVersions?: string[];
  enforceModuleManifest?: boolean;
  allowIsolationFallback?: boolean;
  browserSourceSandboxMode?: RuntimeSourceSandboxMode;
  browserSourceSandboxTimeoutMs?: number;
  browserSourceSandboxFailClosed?: boolean;
  enableDependencyPreflight?: boolean;
  failOnDependencyPreflightError?: boolean;
  remoteFetchTimeoutMs?: number;
  remoteFetchRetries?: number;
  remoteFetchBackoffMs?: number;
  remoteFallbackCdnBases?: string[];
}

export interface RuntimeSourceTranspileInput {
  code: string;
  language: RuntimeSourceLanguage;
  filename?: string;
  runtime?: RuntimeSourceModule["runtime"];
}

export interface RuntimeSourceTranspiler {
  transpile(input: RuntimeSourceTranspileInput): Promise<string>;
}

export interface RuntimeEmbedRenderOptions {
  target?: RenderTarget;
  context?: RuntimeExecutionContext;
  signal?: AbortSignal;
  runtime?: RuntimeManager;
  runtimeOptions?: RuntimeManagerOptions;
  security?: SecurityChecker;
  securityInitialization?: SecurityInitializationInput;
  ui?: UIRenderer;
  autoInitializeRuntime?: boolean;
  autoTerminateRuntime?: boolean;
  serializeTargetRenders?: boolean;
}

export interface RuntimeEmbedRenderResult {
  html: string;
  execution: RuntimeExecutionResult;
  security: SecurityCheckResult;
  runtime: RuntimeManager;
}

export class RuntimeSecurityViolationError extends Error {
  readonly result: SecurityCheckResult;

  constructor(result: SecurityCheckResult) {
    super(`Security policy rejected runtime plan: ${result.issues.join("; ")}`);
    this.name = "RuntimeSecurityViolationError";
    this.result = result;
  }
}

interface ExecutionFrame {
  startedAt: number;
  maxExecutionMs: number;
  maxComponentInvocations: number;
  componentInvocations: number;
  executionProfile: RuntimeExecutionProfile;
  signal?: AbortSignal;
}

interface ResolvedSourceOutput {
  root?: RuntimeNode;
  renderArtifact?: RuntimeRenderArtifact;
}

export type RuntimeSourceSandboxMode = RuntimeSourceRuntimeMode;

export type { RuntimeComponentFactory } from "./runtime-component-runtime";

export class DefaultRuntimeManager implements RuntimeManager {
  private readonly moduleLoader?: RuntimeModuleLoader;
  private readonly sourceTranspiler: RuntimeSourceTranspiler;
  private readonly states = new Map<string, RuntimeStateSnapshot>();
  private readonly defaultMaxImports: number;
  private readonly defaultMaxComponentInvocations: number;
  private readonly defaultMaxExecutionMs: number;
  private readonly defaultExecutionProfile: RuntimeExecutionProfile;
  private readonly supportedPlanSpecVersions: Set<string>;
  private readonly enforceModuleManifest: boolean;
  private readonly allowIsolationFallback: boolean;
  private readonly browserSourceSandboxMode: RuntimeSourceSandboxMode;
  private readonly browserSourceSandboxTimeoutMs: number;
  private readonly browserSourceSandboxFailClosed: boolean;
  private readonly enableDependencyPreflight: boolean;
  private readonly failOnDependencyPreflightError: boolean;
  private readonly remoteFetchTimeoutMs: number;
  private readonly remoteFetchRetries: number;
  private readonly remoteFetchBackoffMs: number;
  private readonly remoteFallbackCdnBases: string[];
  private readonly browserModuleUrlCache = new Map<string, string>();
  private readonly browserModuleInflight = new Map<string, Promise<string>>();
  private readonly browserBlobUrls = new Set<string>();
  private initialized = false;

  constructor(options: RuntimeManagerOptions = {}) {
    this.moduleLoader = options.moduleLoader;
    this.sourceTranspiler =
      options.sourceTranspiler ?? new BabelRuntimeSourceTranspiler();
    this.defaultMaxImports = options.defaultMaxImports ?? FALLBACK_MAX_IMPORTS;
    this.defaultMaxComponentInvocations =
      options.defaultMaxComponentInvocations ??
      FALLBACK_MAX_COMPONENT_INVOCATIONS;
    this.defaultMaxExecutionMs =
      options.defaultMaxExecutionMs ?? FALLBACK_MAX_EXECUTION_MS;
    this.defaultExecutionProfile =
      options.defaultExecutionProfile ?? FALLBACK_EXECUTION_PROFILE;
    this.supportedPlanSpecVersions = normalizeSupportedSpecVersions(
      options.supportedPlanSpecVersions,
    );
    this.enforceModuleManifest =
      options.enforceModuleManifest ?? FALLBACK_ENFORCE_MODULE_MANIFEST;
    this.allowIsolationFallback =
      options.allowIsolationFallback ?? FALLBACK_ALLOW_ISOLATION_FALLBACK;
    this.browserSourceSandboxMode = normalizeSourceSandboxMode(
      options.browserSourceSandboxMode,
    );
    this.browserSourceSandboxTimeoutMs = normalizePositiveInteger(
      options.browserSourceSandboxTimeoutMs,
      FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS,
    );
    this.browserSourceSandboxFailClosed =
      options.browserSourceSandboxFailClosed ??
      FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED;
    this.enableDependencyPreflight =
      options.enableDependencyPreflight ?? FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT;
    this.failOnDependencyPreflightError =
      options.failOnDependencyPreflightError ??
      FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR;
    this.remoteFetchTimeoutMs = normalizePositiveInteger(
      options.remoteFetchTimeoutMs,
      FALLBACK_REMOTE_FETCH_TIMEOUT_MS,
    );
    this.remoteFetchRetries = normalizeNonNegativeInteger(
      options.remoteFetchRetries,
      FALLBACK_REMOTE_FETCH_RETRIES,
    );
    this.remoteFetchBackoffMs = normalizeNonNegativeInteger(
      options.remoteFetchBackoffMs,
      FALLBACK_REMOTE_FETCH_BACKOFF_MS,
    );
    this.remoteFallbackCdnBases = normalizeFallbackCdnBases(
      options.remoteFallbackCdnBases,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
  }

  async terminate(): Promise<void> {
    this.initialized = false;
    this.states.clear();
    this.browserModuleUrlCache.clear();
    this.browserModuleInflight.clear();
    this.revokeBrowserBlobUrls();
  }

  async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
    return this.executePlan(
      input.plan,
      input.context,
      input.event,
      input.stateOverride,
      input.signal,
    );
  }

  async probePlan(plan: RuntimePlan): Promise<RuntimePlanProbeResult> {
    this.ensureInitialized();

    const diagnostics: RuntimeDiagnostic[] = [];
    const specVersion = resolveRuntimePlanSpecVersion(plan.specVersion);
    if (!this.supportedPlanSpecVersions.has(specVersion)) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_SPEC_VERSION_UNSUPPORTED",
        message: `Unsupported plan specVersion "${specVersion}". Supported: ${[
          ...this.supportedPlanSpecVersions,
        ].join(", ")}`,
      });
      return {
        planId: plan.id,
        diagnostics,
        dependencies: [],
      };
    }

    const frame: ExecutionFrame = {
      startedAt: nowMs(),
      maxExecutionMs:
        plan.capabilities.maxExecutionMs ?? this.defaultMaxExecutionMs,
      maxComponentInvocations:
        plan.capabilities.maxComponentInvocations ??
        this.defaultMaxComponentInvocations,
      componentInvocations: 0,
      executionProfile:
        plan.capabilities.executionProfile ?? this.defaultExecutionProfile,
    };

    const dependencies = await this.preflightPlanDependencies(
      plan,
      diagnostics,
      frame,
    );

    return {
      planId: plan.id,
      diagnostics,
      dependencies,
    };
  }

  async executePlan(
    plan: RuntimePlan,
    context: RuntimeExecutionContext = {},
    event?: RuntimeEvent,
    stateOverride?: RuntimeStateSnapshot,
    signal?: AbortSignal,
  ): Promise<RuntimeExecutionResult> {
    this.ensureInitialized();
    this.throwIfAborted(signal);

    const specVersion = resolveRuntimePlanSpecVersion(plan.specVersion);
    const diagnostics: RuntimeDiagnostic[] = [];

    if (!this.supportedPlanSpecVersions.has(specVersion)) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_SPEC_VERSION_UNSUPPORTED",
        message: `Unsupported plan specVersion "${specVersion}". Supported: ${[
          ...this.supportedPlanSpecVersions,
        ].join(", ")}`,
      });
      return {
        planId: plan.id,
        root: plan.root,
        diagnostics,
        state: cloneJsonValue(this.resolveState(plan, stateOverride)),
        handledEvent: event,
        appliedActions: [],
      };
    }

    const state = this.resolveState(plan, stateOverride);
    const appliedActions: RuntimeAction[] = [];

    const frame: ExecutionFrame = {
      startedAt: nowMs(),
      maxExecutionMs:
        plan.capabilities.maxExecutionMs ?? this.defaultMaxExecutionMs,
      maxComponentInvocations:
        plan.capabilities.maxComponentInvocations ??
        this.defaultMaxComponentInvocations,
      componentInvocations: 0,
      executionProfile:
        plan.capabilities.executionProfile ?? this.defaultExecutionProfile,
      signal,
    };

    const maxImports = plan.capabilities.maxImports ?? this.defaultMaxImports;
    const imports = plan.imports ?? [];

    if (this.enableDependencyPreflight) {
      await this.preflightPlanDependencies(plan, diagnostics, frame);
      if (
        this.failOnDependencyPreflightError &&
        diagnostics.some(
          (item) =>
            item.level === "error" &&
            item.code.startsWith("RUNTIME_PREFLIGHT_"),
        )
      ) {
        return {
          planId: plan.id,
          root: plan.root,
          diagnostics,
          state: cloneJsonValue(state),
          handledEvent: event,
          appliedActions,
        };
      }
    }

    for (let i = 0; i < imports.length; i += 1) {
      if (this.isAborted(frame.signal)) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_ABORTED",
          message: "Execution aborted before import resolution",
        });
        break;
      }
      const specifier = imports[i];
      const resolvedSpecifier = this.resolveRuntimeSpecifier(
        specifier,
        plan.moduleManifest,
        diagnostics,
        "import",
      );
      if (!resolvedSpecifier) {
        continue;
      }

      if (i >= maxImports) {
        diagnostics.push({
          level: "warning",
          code: "RUNTIME_IMPORT_LIMIT_EXCEEDED",
          message: `Import skipped because maxImports=${maxImports}: ${specifier}`,
        });
        continue;
      }

      if (!this.moduleLoader) {
        diagnostics.push({
          level: "warning",
          code: "RUNTIME_LOADER_MISSING",
          message: `Import skipped because no module loader is configured: ${resolvedSpecifier}`,
        });
        continue;
      }

      if (this.hasExceededBudget(frame)) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_TIMEOUT",
          message: `Execution time budget exceeded before importing: ${specifier}`,
        });
        break;
      }

      try {
        await this.withRemainingBudget(
          () => this.moduleLoader!.load(resolvedSpecifier),
          frame,
          `Import timed out: ${resolvedSpecifier}`,
        );
      } catch (error) {
        if (this.isAbortError(error)) {
          diagnostics.push({
            level: "error",
            code: "RUNTIME_ABORTED",
            message: `Execution aborted during import: ${resolvedSpecifier}`,
          });
          break;
        }
        diagnostics.push({
          level: "error",
          code: "RUNTIME_IMPORT_FAILED",
          message: `${resolvedSpecifier}: ${this.errorToMessage(error)}`,
        });
      }
    }

    const sourceRoot = plan.source
      ? await this.resolveSourceRoot(
          plan,
          plan.source,
          context,
          state,
          event,
          diagnostics,
          frame,
        )
      : undefined;

    const sourceRenderArtifact = sourceRoot?.renderArtifact;

    const resolvedRoot = sourceRoot?.root
      ? await this.resolveNode(
          sourceRoot.root,
          plan.moduleManifest,
          context,
          state,
          event,
          diagnostics,
          frame,
        )
      : await this.resolveNode(
          plan.root,
          plan.moduleManifest,
          context,
          state,
          event,
          diagnostics,
          frame,
        );

    return {
      planId: plan.id,
      root: resolvedRoot,
      diagnostics,
      state: cloneJsonValue(state),
      handledEvent: event,
      appliedActions,
      ...(sourceRenderArtifact ? { renderArtifact: sourceRenderArtifact } : {}),
    };
  }

  async compile(
    plan: RuntimePlan,
    options: CompileOptions = {},
  ): Promise<string> {
    const indent = options.pretty ? 2 : 0;
    return JSON.stringify(plan, null, indent);
  }

  getPlanState(planId: string): RuntimeStateSnapshot | undefined {
    const snapshot = this.states.get(planId);
    if (!snapshot) {
      return undefined;
    }

    return cloneJsonValue(snapshot);
  }

  setPlanState(planId: string, snapshot: RuntimeStateSnapshot): void {
    this.states.set(planId, cloneJsonValue(snapshot));
  }

  clearPlanState(planId: string): void {
    this.states.delete(planId);
  }

  private resolveState(
    plan: RuntimePlan,
    stateOverride?: RuntimeStateSnapshot,
  ): RuntimeStateSnapshot {
    if (stateOverride) {
      return cloneJsonValue(stateOverride);
    }

    if (plan.state?.initial) {
      return cloneJsonValue(plan.state.initial);
    }

    return {};
  }

  private applyEvent(
    plan: RuntimePlan,
    event: RuntimeEvent | undefined,
    state: RuntimeStateSnapshot,
    context: RuntimeExecutionContext,
    diagnostics: RuntimeDiagnostic[],
  ): RuntimeAction[] {
    if (!event) {
      return [];
    }

    const transitions = plan.state?.transitions;
    if (!transitions) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_EVENT_IGNORED",
        message: `Event ${event.type} ignored because plan has no transitions`,
      });
      return [];
    }

    const actions = transitions[event.type];
    if (!actions || actions.length === 0) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_EVENT_NO_HANDLER",
        message: `Event ${event.type} has no transition handler`,
      });
      return [];
    }

    const applied: RuntimeAction[] = [];

    for (const action of actions) {
      try {
        applyRuntimeAction(action, state, event, context);
        applied.push(action);
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_ACTION_FAILED",
          message: `${action.type}:${action.path}: ${this.errorToMessage(error)}`,
        });
      }
    }

    return applied;
  }

  private async preflightPlanDependencies(
    plan: RuntimePlan,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<RuntimeDependencyProbeStatus[]> {
    const probes = await collectDependencyProbes(
      plan,
      this.parseSourceImportSpecifiers.bind(this),
    );

    return runDependencyPreflight(
      probes,
      diagnostics,
      (probe) =>
        this.preflightDependencyProbe(
          probe,
          plan.moduleManifest,
          diagnostics,
          frame,
        ),
      {
        isAborted: () => this.isAborted(frame.signal),
        hasExceededBudget: () => this.hasExceededBudget(frame),
      },
    );
  }

  private async parseSourceImportSpecifiers(code: string): Promise<string[]> {
    if (code.trim().length === 0) {
      return [];
    }

    const imports = new Set<string>();
    const parsedSpecifiers = await parseImportSpecifiersFromSource(code);
    for (const entry of parsedSpecifiers) {
      imports.add(entry.specifier);
    }

    return [...imports];
  }

  private async preflightDependencyProbe(
    probe: DependencyProbe,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<RuntimeDependencyProbeStatus> {
    return executeDependencyProbe(probe, moduleManifest, diagnostics, {
      moduleLoader: this.moduleLoader,
      withRemainingBudget: (operation, timeoutMessage) =>
        this.withRemainingBudget(operation, frame, timeoutMessage),
      resolveRuntimeSourceSpecifier: (
        specifier,
        manifest,
        runtimeDiagnostics,
        requireManifest,
      ) =>
        this.resolveRuntimeSourceSpecifier(
          specifier,
          manifest,
          runtimeDiagnostics,
          requireManifest,
        ),
      resolveSourceImportLoaderCandidate: (specifier, manifest) =>
        this.resolveSourceImportLoaderCandidate(specifier, manifest),
      resolveRuntimeSpecifier: (
        specifier,
        manifest,
        runtimeDiagnostics,
        usage,
      ) =>
        this.resolveRuntimeSpecifier(
          specifier,
          manifest,
          runtimeDiagnostics,
          usage,
        ),
      isHttpUrl,
      canMaterializeBrowserModules: () => this.canMaterializeBrowserModules(),
      materializeBrowserRemoteModule: (url, manifest, runtimeDiagnostics) =>
        this.materializeBrowserRemoteModule(url, manifest, runtimeDiagnostics),
      fetchRemoteModuleCodeWithFallback: (url, runtimeDiagnostics) =>
        this.fetchRemoteModuleCodeWithFallback(url, runtimeDiagnostics),
      isAbortError: (error) => this.isAbortError(error),
      errorToMessage: (error) => this.errorToMessage(error),
    });
  }

  private async resolveSourceRoot(
    plan: RuntimePlan,
    source: RuntimeSourceModule,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<ResolvedSourceOutput | undefined> {
    try {
      const exportName = source.exportName ?? "default";
      const runtimeInput = {
        context: cloneJsonValue(asJsonValue(context)),
        state: cloneJsonValue(state),
        event: event ? cloneJsonValue(asJsonValue(event)) : null,
      };
      const transpiled = await this.withRemainingBudget(
        () => this.transpileRuntimeSource(source),
        frame,
        "Runtime source transpilation timed out",
      );
      const rewritten = await this.rewriteSourceImports(
        transpiled,
        plan.moduleManifest,
        diagnostics,
      );

      const sandboxMode = this.resolveSourceSandboxMode(
        source,
        frame.executionProfile,
      );
      if (sandboxMode !== "none") {
        try {
          const sandboxResult = await this.withRemainingBudget(
            () =>
              executeSourceInBrowserSandbox({
                mode: sandboxMode,
                timeoutMs: this.browserSourceSandboxTimeoutMs,
                signal: frame.signal,
                request: {
                  renderifySandbox: "runtime-source",
                  id: `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
                  code: rewritten,
                  exportName,
                  runtimeInput,
                } satisfies RuntimeSandboxRequest,
              }),
            frame,
            `Runtime source sandbox (${sandboxMode}) timed out`,
          );

          const normalized = this.normalizeSourceOutput(sandboxResult.output);
          if (!normalized) {
            diagnostics.push({
              level: "error",
              code: "RUNTIME_SOURCE_OUTPUT_INVALID",
              message:
                "Runtime source output from sandbox is not a supported RuntimeNode payload",
            });
            return undefined;
          }

          diagnostics.push({
            level: "info",
            code: "RUNTIME_SOURCE_SANDBOX_EXECUTED",
            message: `Runtime source executed in ${sandboxMode} sandbox`,
          });

          return {
            root: normalized,
          };
        } catch (error) {
          if (this.isAbortError(error)) {
            throw error;
          }
          const message = this.errorToMessage(error);
          diagnostics.push({
            level: this.browserSourceSandboxFailClosed ? "error" : "warning",
            code: this.browserSourceSandboxFailClosed
              ? "RUNTIME_SOURCE_SANDBOX_FAILED"
              : "RUNTIME_SOURCE_SANDBOX_FALLBACK",
            message,
          });

          if (this.browserSourceSandboxFailClosed) {
            throw new Error(
              `Runtime source sandbox (${sandboxMode}) failed: ${message}`,
            );
          }
        }
      }

      const namespace = await this.withRemainingBudget(
        () =>
          this.importSourceModuleFromCode(
            rewritten,
            plan.moduleManifest,
            diagnostics,
          ),
        frame,
        "Runtime source module loading timed out",
      );

      const selected = selectExportFromNamespace(namespace, exportName);
      if (selected === undefined) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_SOURCE_EXPORT_MISSING",
          message: `Runtime source export "${exportName}" is missing`,
        });
        return undefined;
      }

      if (this.shouldUsePreactSourceRuntime(source)) {
        const preactArtifact =
          await createPreactRenderArtifactFromComponentRuntime({
            sourceExport: selected,
            runtimeInput,
            diagnostics,
          });
        if (preactArtifact) {
          return {
            renderArtifact: preactArtifact,
          };
        }
      }

      const produced =
        typeof selected === "function"
          ? await this.withRemainingBudget(
              async () =>
                (selected as (input: unknown) => unknown)(runtimeInput),
              frame,
              "Runtime source export execution timed out",
            )
          : selected;

      const normalized = this.normalizeSourceOutput(produced);
      if (!normalized) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_SOURCE_OUTPUT_INVALID",
          message:
            "Runtime source output is not a supported RuntimeNode payload",
        });
        return undefined;
      }

      return {
        root: normalized,
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        throw error;
      }
      diagnostics.push({
        level: "error",
        code: "RUNTIME_SOURCE_EXEC_FAILED",
        message: this.errorToMessage(error),
      });
      return undefined;
    }
  }

  private resolveSourceSandboxMode(
    source: RuntimeSourceModule,
    executionProfile: RuntimeExecutionProfile,
  ): RuntimeSourceSandboxMode {
    return resolveSourceSandboxMode({
      source,
      executionProfile,
      defaultMode: this.browserSourceSandboxMode,
      isBrowserRuntime: isBrowserRuntime(),
    });
  }

  private async transpileRuntimeSource(
    source: RuntimeSourceModule,
  ): Promise<string> {
    return transpileRuntimeSource(source, this.sourceTranspiler);
  }

  private shouldUsePreactSourceRuntime(source: RuntimeSourceModule): boolean {
    return shouldUsePreactSourceRuntime(source);
  }

  private async rewriteSourceImports(
    code: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string> {
    return this.rewriteImportsAsync(code, async (specifier) =>
      this.resolveRuntimeSourceSpecifier(
        specifier,
        moduleManifest,
        diagnostics,
      ),
    );
  }

  private resolveRuntimeSourceSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest = true,
  ): string {
    return resolveRuntimeSourceSpecifier({
      specifier,
      moduleManifest,
      diagnostics,
      requireManifest,
      enforceModuleManifest: this.enforceModuleManifest,
      moduleLoader: this.moduleLoader,
      jspmCdnBase: FALLBACK_JSPM_CDN_BASE,
    });
  }

  private resolveSourceImportLoaderCandidate(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): string | undefined {
    return resolveSourceImportLoaderCandidate(
      specifier,
      moduleManifest,
      this.moduleLoader,
    );
  }

  private resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    usage: "import" | "component" | "source-import",
  ): string | undefined {
    return resolveRuntimeSpecifier({
      specifier,
      moduleManifest,
      diagnostics,
      usage,
      enforceModuleManifest: this.enforceModuleManifest,
    });
  }

  private async importSourceModuleFromCode(
    code: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<unknown> {
    const isNodeRuntime =
      typeof process !== "undefined" &&
      process !== null &&
      typeof process.versions === "object" &&
      process.versions !== null &&
      typeof process.versions.node === "string";

    if (isNodeRuntime && typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      const dataUrl = `data:text/javascript;base64,${encoded}`;
      return import(/* webpackIgnore: true */ dataUrl);
    }

    if (this.canMaterializeBrowserModules()) {
      const rewrittenEntry = await this.rewriteImportsAsync(
        code,
        async (specifier) =>
          this.resolveBrowserImportSpecifier(
            specifier,
            undefined,
            moduleManifest,
            diagnostics,
          ),
      );
      const entryUrl = this.createBrowserBlobModuleUrl(rewrittenEntry);
      return import(/* webpackIgnore: true */ entryUrl);
    }

    if (typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      const dataUrl = `data:text/javascript;base64,${encoded}`;
      return import(/* webpackIgnore: true */ dataUrl);
    }

    throw new Error("No runtime module import strategy is available");
  }

  private canMaterializeBrowserModules(): boolean {
    return canMaterializeBrowserModules();
  }

  private async resolveBrowserImportSpecifier(
    specifier: string,
    parentUrl: string | undefined,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string> {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return trimmed;
    }

    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
      return trimmed;
    }

    if (isHttpUrl(trimmed)) {
      return this.materializeBrowserRemoteModule(
        trimmed,
        moduleManifest,
        diagnostics,
      );
    }

    if (
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.startsWith("/")
    ) {
      if (!parentUrl || !isHttpUrl(parentUrl)) {
        diagnostics.push({
          level: "warning",
          code: "RUNTIME_SOURCE_IMPORT_UNRESOLVED",
          message: `Cannot resolve relative source import without parent URL: ${trimmed}`,
        });
        return trimmed;
      }

      const absolute = new URL(trimmed, parentUrl).toString();
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeBrowserRemoteModule(
        absolute,
        moduleManifest,
        diagnostics,
      );
    }

    const resolved = this.resolveRuntimeSourceSpecifier(
      trimmed,
      moduleManifest,
      diagnostics,
      false,
    );

    if (isHttpUrl(resolved)) {
      return this.materializeBrowserRemoteModule(
        resolved,
        moduleManifest,
        diagnostics,
      );
    }

    if (
      (resolved.startsWith("./") ||
        resolved.startsWith("../") ||
        resolved.startsWith("/")) &&
      parentUrl &&
      isHttpUrl(parentUrl)
    ) {
      const absolute = new URL(resolved, parentUrl).toString();
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeBrowserRemoteModule(
        absolute,
        moduleManifest,
        diagnostics,
      );
    }

    return resolved;
  }

  private async materializeBrowserRemoteModule(
    url: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string> {
    const normalizedUrl = url.trim();
    if (normalizedUrl.length === 0) {
      return normalizedUrl;
    }

    const cachedUrl = this.browserModuleUrlCache.get(normalizedUrl);
    if (cachedUrl) {
      return cachedUrl;
    }

    const inflight = this.browserModuleInflight.get(normalizedUrl);
    if (inflight) {
      return inflight;
    }

    const loading = (async () => {
      const fetched = await this.fetchRemoteModuleCodeWithFallback(
        normalizedUrl,
        diagnostics,
      );
      const rewritten = await this.materializeFetchedModuleSource(
        fetched,
        moduleManifest,
        diagnostics,
      );

      const blobUrl = this.createBrowserBlobModuleUrl(rewritten);
      this.browserModuleUrlCache.set(normalizedUrl, blobUrl);
      this.browserModuleUrlCache.set(fetched.url, blobUrl);
      return blobUrl;
    })();

    this.browserModuleInflight.set(normalizedUrl, loading);
    try {
      return await loading;
    } finally {
      this.browserModuleInflight.delete(normalizedUrl);
    }
  }

  private async materializeFetchedModuleSource(
    fetched: RemoteModuleFetchResult,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string> {
    if (this.isCssModuleResponse(fetched)) {
      return this.createCssProxyModuleSource(fetched.code, fetched.url);
    }

    if (this.isJsonModuleResponse(fetched)) {
      return this.createJsonProxyModuleSource(fetched, diagnostics);
    }

    if (!this.isJavaScriptModuleResponse(fetched)) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_SOURCE_ASSET_PROXY",
        message: `Treating non-JS module as proxied asset: ${fetched.url} (${fetched.contentType || "unknown"})`,
      });

      if (this.isBinaryLikeContentType(fetched.contentType)) {
        return this.createUrlProxyModuleSource(fetched.url);
      }

      return this.createTextProxyModuleSource(fetched.code);
    }

    return this.rewriteImportsAsync(fetched.code, async (childSpecifier) =>
      this.resolveBrowserImportSpecifier(
        childSpecifier,
        fetched.url,
        moduleManifest,
        diagnostics,
      ),
    );
  }

  private async fetchRemoteModuleCodeWithFallback(
    url: string,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<RemoteModuleFetchResult> {
    const attempts = this.buildRemoteModuleAttemptUrls(url);

    let lastError: unknown;
    for (const attempt of attempts) {
      for (let retry = 0; retry <= this.remoteFetchRetries; retry += 1) {
        try {
          const response = await this.fetchWithTimeout(
            attempt,
            this.remoteFetchTimeoutMs,
          );
          if (!response.ok) {
            throw new Error(
              `Failed to load module ${attempt}: HTTP ${response.status}`,
            );
          }

          if (attempt !== url) {
            diagnostics.push({
              level: "warning",
              code: "RUNTIME_SOURCE_IMPORT_FALLBACK_USED",
              message: `Loaded module via fallback URL: ${url} -> ${attempt}`,
            });
          }

          if (retry > 0) {
            diagnostics.push({
              level: "warning",
              code: "RUNTIME_SOURCE_IMPORT_RETRY_SUCCEEDED",
              message: `Recovered remote module after retry ${retry}: ${attempt}`,
            });
          }

          return {
            url: response.url || attempt,
            code: await response.text(),
            contentType:
              response.headers.get("content-type")?.toLowerCase() ?? "",
            requestUrl: attempt,
          };
        } catch (error) {
          lastError = error;
          if (retry >= this.remoteFetchRetries) {
            break;
          }
          await this.delay(this.remoteFetchBackoffMs * Math.max(1, retry + 1));
        }
      }
    }

    throw lastError ?? new Error(`Failed to load module: ${url}`);
  }

  private buildRemoteModuleAttemptUrls(url: string): string[] {
    return buildRemoteModuleAttemptUrls(url, this.remoteFallbackCdnBases);
  }

  private toConfiguredFallbackUrl(
    url: string,
    cdnBase: string,
  ): string | undefined {
    return toConfiguredFallbackUrl(url, cdnBase);
  }

  private toEsmFallbackUrl(
    url: string,
    cdnBase = FALLBACK_ESM_CDN_BASE,
  ): string | undefined {
    return toEsmFallbackUrl(url, cdnBase);
  }

  private extractJspmNpmSpecifier(url: string): string | undefined {
    return extractJspmNpmSpecifier(url);
  }

  private isCssModuleResponse(fetched: RemoteModuleFetchResult): boolean {
    return isCssModuleResponse(fetched);
  }

  private isJsonModuleResponse(fetched: RemoteModuleFetchResult): boolean {
    return isJsonModuleResponse(fetched);
  }

  private isJavaScriptModuleResponse(
    fetched: RemoteModuleFetchResult,
  ): boolean {
    return isJavaScriptModuleResponse(fetched);
  }

  private isBinaryLikeContentType(contentType: string): boolean {
    return isBinaryLikeContentType(contentType);
  }

  private createCssProxyModuleSource(
    cssText: string,
    sourceUrl: string,
  ): string {
    return createCssProxyModuleSource(cssText, sourceUrl);
  }

  private createJsonProxyModuleSource(
    fetched: RemoteModuleFetchResult,
    diagnostics: RuntimeDiagnostic[],
  ): string {
    try {
      const parsed = JSON.parse(fetched.code) as unknown;
      return createJsonProxyModuleSource(parsed);
    } catch (error) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_SOURCE_JSON_PARSE_FAILED",
        message: `${fetched.requestUrl}: ${this.errorToMessage(error)}`,
      });
      return this.createTextProxyModuleSource(fetched.code);
    }
  }

  private createTextProxyModuleSource(text: string): string {
    return createTextProxyModuleSource(text);
  }

  private createUrlProxyModuleSource(url: string): string {
    return createUrlProxyModuleSource(url);
  }

  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<Response> {
    return fetchWithTimeout(url, timeoutMs);
  }

  private async delay(ms: number): Promise<void> {
    return delay(ms);
  }

  private async rewriteImportsAsync(
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ): Promise<string> {
    return rewriteImportsAsync(code, resolver);
  }

  private createBrowserBlobModuleUrl(code: string): string {
    return createBrowserBlobModuleUrl(code, this.browserBlobUrls);
  }

  private revokeBrowserBlobUrls(): void {
    revokeBrowserBlobUrls(this.browserBlobUrls);
  }

  private normalizeSourceOutput(output: unknown): RuntimeNode | undefined {
    return normalizeRuntimeSourceOutput(output);
  }

  private async resolveNode(
    node: RuntimeNode,
    moduleManifest: RuntimeModuleManifest | undefined,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<RuntimeNode> {
    this.throwIfAborted(frame.signal);

    if (this.hasExceededBudget(frame)) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_TIMEOUT",
        message: "Execution time budget exceeded during node resolution",
      });
      return createElementNode("div", { "data-renderify-timeout": "true" }, [
        createTextNode("Runtime execution timed out"),
      ]);
    }

    return resolveRuntimeNode({
      node,
      moduleManifest,
      context,
      state,
      event,
      diagnostics,
      frame,
      resolver: {
        moduleLoader: this.moduleLoader,
        allowIsolationFallback: this.allowIsolationFallback,
        resolveRuntimeSpecifier: (
          specifier,
          manifest,
          runtimeDiagnostics,
          usage,
        ) =>
          this.resolveRuntimeSpecifier(
            specifier,
            manifest,
            runtimeDiagnostics,
            usage,
          ),
        withRemainingBudget: (operation, timeoutMessage) =>
          this.withRemainingBudget(operation, frame, timeoutMessage),
        resolveNode: (nextNode) =>
          this.resolveNode(
            nextNode,
            moduleManifest,
            context,
            state,
            event,
            diagnostics,
            frame,
          ),
        errorToMessage: (error) => this.errorToMessage(error),
      },
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("RuntimeManager is not initialized");
    }
  }

  private hasExceededBudget(frame: ExecutionFrame): boolean {
    return hasRuntimeExceededBudget(frame);
  }

  private async withRemainingBudget<T>(
    operation: () => Promise<T>,
    frame: ExecutionFrame,
    timeoutMessage: string,
  ): Promise<T> {
    return withRuntimeRemainingBudget(operation, frame, timeoutMessage);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    throwIfRuntimeAborted(signal);
  }

  private isAborted(signal?: AbortSignal): boolean {
    return isRuntimeAborted(signal);
  }

  private isAbortError(error: unknown): boolean {
    return isRuntimeAbortError(error);
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
