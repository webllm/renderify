import {
  asJsonValue,
  cloneJsonValue,
  createElementNode,
  createTextNode,
  getValueByPath,
  isRuntimeValueFromPath,
  isSafePath,
  type JsonValue,
  matchesAllowedNetworkUrl,
  type ParsedNetworkHostPattern,
  parseNetworkHostPattern,
  type RuntimeAction,
  type RuntimeActionValue,
  type RuntimeDiagnostic,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeExecutionProfile,
  type RuntimeExecutionResult,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimeSourceModule,
  type RuntimeStateSnapshot,
  resolveRuntimePlanSpecVersion,
  setValueByPath,
} from "@renderify/ir";
import type { RemoteModuleFetchResult } from "./module-fetch";
import { isRuntimeModuleIntegrityError } from "./module-integrity";
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
  FALLBACK_ALLOW_RUNTIME_SOURCE_EXECUTION,
  FALLBACK_BROWSER_MODULE_URL_CACHE_MAX_ENTRIES,
  FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED,
  FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS,
  FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT,
  FALLBACK_ENFORCE_MODULE_MANIFEST,
  FALLBACK_EXECUTION_PROFILE,
  FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR,
  FALLBACK_JSPM_CDN_BASE,
  FALLBACK_MAX_COMPONENT_INVOCATIONS,
  FALLBACK_MAX_EXECUTION_MS,
  FALLBACK_MAX_IMPORTS,
  FALLBACK_REMOTE_FALLBACK_CDN_BASES,
  FALLBACK_REMOTE_FETCH_BACKOFF_MS,
  FALLBACK_REMOTE_FETCH_RETRIES,
  FALLBACK_REMOTE_FETCH_TIMEOUT_MS,
  FALLBACK_REMOTE_MODULE_MAX_BYTES,
  FALLBACK_RUNTIME_SOURCE_JSX_HELPER_MODE,
  FALLBACK_RUNTIME_SOURCE_LOCAL_SPECIFIER_CACHE_MAX_ENTRIES,
  normalizeFallbackCdnBases,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeRuntimeSourceJsxHelperMode,
  normalizeSourceSandboxMode,
  normalizeSupportedSpecVersions,
} from "./runtime-defaults";
import { isBrowserRuntime, isNodeRuntime, nowMs } from "./runtime-environment";
import type {
  CompileOptions,
  RuntimeExecutionInput,
  RuntimeManager,
  RuntimeManagerOptions,
  RuntimeModuleLoader,
  RuntimePlanProbeResult,
  RuntimeSourceSandboxMode,
  RuntimeSourceTranspiler,
} from "./runtime-manager.types";
import {
  createRuntimeModuleMaterializationBudget,
  loadRuntimeModuleWithBudget,
  loadVerifiedRuntimeModuleWithBudget,
  type RuntimeModuleMaterializationBudget,
} from "./runtime-module-materialization-budget";
import { resolveRuntimeNode } from "./runtime-node-resolver";
import { resolveRuntimePlanImports } from "./runtime-plan-imports";
import { preflightRuntimePlanDependencies } from "./runtime-plan-preflight";
import type { RuntimeDependencyProbeStatus } from "./runtime-preflight";
import {
  executeRuntimeSourceRoot,
  type ResolvedSourceOutput,
} from "./runtime-source-execution";
import { RuntimeSourceModuleLoader } from "./runtime-source-module-loader";
import {
  resolveSourceSandboxMode,
  shouldUsePreactSourceRuntime,
  transpileRuntimeSource,
} from "./runtime-source-runtime";
import {
  canMaterializeBrowserModules,
  createBrowserBlobModuleUrl,
  normalizeRuntimeSourceOutput,
  revokeBrowserBlobUrls,
  rewriteImportsAsync,
} from "./runtime-source-utils";
import {
  resolveRuntimeSourceSpecifier,
  resolveRuntimeSpecifier,
  resolveSourceImportLoaderCandidate,
} from "./runtime-specifier";
import { DefaultRuntimeSourceTranspiler } from "./transpiler";

interface ExecutionFrame {
  startedAt: number;
  maxExecutionMs: number;
  maxComponentInvocations: number;
  componentInvocations: number;
  executionProfile: RuntimeExecutionProfile;
  materializationBudget: RuntimeModuleMaterializationBudget;
  signal?: AbortSignal;
}

const EMOTION_CACHE_BRIDGE_SOURCE = [
  'import { CacheProvider } from "https://esm.sh/@emotion/react@^11.5.0?alias=react:preact/compat&target=es2022";',
  'import createCache from "https://esm.sh/@emotion/cache@^11.14.0?bundle&target=node";',
  "export { CacheProvider, createCache };",
].join("\n");

export type { RuntimeComponentFactory } from "./runtime-component-runtime";

export class DefaultRuntimeManager implements RuntimeManager {
  private readonly moduleLoader?: RuntimeModuleLoader;
  private readonly sourceTranspiler: RuntimeSourceTranspiler;
  private readonly states = new Map<string, RuntimeStateSnapshot>();
  private readonly defaultMaxImports: number;
  private readonly defaultMaxComponentInvocations: number;
  private readonly defaultMaxExecutionMs: number;
  private readonly defaultExecutionProfile: RuntimeExecutionProfile;
  private supportedPlanSpecVersions: Set<string>;
  private enforceModuleManifest: boolean;
  private allowRuntimeSourceExecution: boolean;
  private allowIsolationFallback: boolean;
  private browserSourceSandboxMode: RuntimeSourceSandboxMode;
  private readonly runtimeSourceJsxHelperMode: "auto" | "always" | "never";
  private browserSourceSandboxTimeoutMs: number;
  private browserSourceSandboxFailClosed: boolean;
  private enableDependencyPreflight: boolean;
  private failOnDependencyPreflightError: boolean;
  private remoteFetchTimeoutMs: number;
  private remoteFetchRetries: number;
  private remoteFetchBackoffMs: number;
  private remoteModuleMaxBytes: number;
  private remoteFallbackCdnBases: string[];
  private browserModuleUrlCacheMaxEntries: number;
  private runtimeSourceLocalSpecifierCacheMaxEntries: number;
  private allowArbitraryNetwork: boolean;
  private allowedNetworkHosts: Set<string>;
  private allowedNetworkHostMatchers: ParsedNetworkHostPattern[];
  private readonly browserModuleUrlCache = new Map<string, string>();
  private readonly browserModuleInflight = new Map<string, Promise<string>>();
  private readonly browserBlobUrls = new Set<string>();
  private readonly browserBlobUrlsByCode = new Map<string, string>();
  private initialized = false;

  constructor(options: RuntimeManagerOptions = {}) {
    this.moduleLoader = options.moduleLoader;
    this.sourceTranspiler =
      options.sourceTranspiler ?? new DefaultRuntimeSourceTranspiler();
    this.defaultMaxImports = options.defaultMaxImports ?? FALLBACK_MAX_IMPORTS;
    this.defaultMaxComponentInvocations =
      options.defaultMaxComponentInvocations ??
      FALLBACK_MAX_COMPONENT_INVOCATIONS;
    this.defaultMaxExecutionMs =
      options.defaultMaxExecutionMs ?? FALLBACK_MAX_EXECUTION_MS;
    this.defaultExecutionProfile =
      options.defaultExecutionProfile ?? FALLBACK_EXECUTION_PROFILE;
    this.runtimeSourceJsxHelperMode = normalizeRuntimeSourceJsxHelperMode(
      options.runtimeSourceJsxHelperMode ??
        FALLBACK_RUNTIME_SOURCE_JSX_HELPER_MODE,
    );
    this.supportedPlanSpecVersions = new Set<string>();
    this.enforceModuleManifest = FALLBACK_ENFORCE_MODULE_MANIFEST;
    this.allowRuntimeSourceExecution = FALLBACK_ALLOW_RUNTIME_SOURCE_EXECUTION;
    this.allowIsolationFallback = FALLBACK_ALLOW_ISOLATION_FALLBACK;
    this.browserSourceSandboxMode = normalizeSourceSandboxMode(undefined);
    this.browserSourceSandboxTimeoutMs =
      FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS;
    this.browserSourceSandboxFailClosed =
      FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED;
    this.enableDependencyPreflight = FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT;
    this.failOnDependencyPreflightError =
      FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR;
    this.remoteFetchTimeoutMs = FALLBACK_REMOTE_FETCH_TIMEOUT_MS;
    this.remoteFetchRetries = FALLBACK_REMOTE_FETCH_RETRIES;
    this.remoteFetchBackoffMs = FALLBACK_REMOTE_FETCH_BACKOFF_MS;
    this.remoteModuleMaxBytes = FALLBACK_REMOTE_MODULE_MAX_BYTES;
    this.remoteFallbackCdnBases = [...FALLBACK_REMOTE_FALLBACK_CDN_BASES];
    this.browserModuleUrlCacheMaxEntries =
      FALLBACK_BROWSER_MODULE_URL_CACHE_MAX_ENTRIES;
    this.runtimeSourceLocalSpecifierCacheMaxEntries =
      FALLBACK_RUNTIME_SOURCE_LOCAL_SPECIFIER_CACHE_MAX_ENTRIES;
    this.allowArbitraryNetwork = true;
    this.allowedNetworkHosts = new Set<string>();
    this.allowedNetworkHostMatchers = [];
    this.applyRuntimeOptions(options, true);
  }

  configure(options: RuntimeManagerOptions): void {
    this.applyRuntimeOptions(options, false);
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
    this.browserBlobUrlsByCode.clear();
    this.revokeBrowserBlobUrls();
  }

  private applyRuntimeOptions(
    options: RuntimeManagerOptions,
    applyDefaults: boolean,
  ): void {
    const networkPolicyChanged =
      applyDefaults ||
      options.allowArbitraryNetwork !== undefined ||
      options.allowedNetworkHosts !== undefined;
    if (applyDefaults || options.supportedPlanSpecVersions !== undefined) {
      this.supportedPlanSpecVersions = normalizeSupportedSpecVersions(
        options.supportedPlanSpecVersions,
      );
    }

    if (applyDefaults || options.enforceModuleManifest !== undefined) {
      this.enforceModuleManifest =
        options.enforceModuleManifest ?? FALLBACK_ENFORCE_MODULE_MANIFEST;
    }

    if (applyDefaults || options.allowRuntimeSourceExecution !== undefined) {
      this.allowRuntimeSourceExecution =
        options.allowRuntimeSourceExecution ??
        FALLBACK_ALLOW_RUNTIME_SOURCE_EXECUTION;
    }

    if (applyDefaults || options.allowIsolationFallback !== undefined) {
      this.allowIsolationFallback =
        options.allowIsolationFallback ?? FALLBACK_ALLOW_ISOLATION_FALLBACK;
    }

    if (applyDefaults || options.browserSourceSandboxMode !== undefined) {
      this.browserSourceSandboxMode = normalizeSourceSandboxMode(
        options.browserSourceSandboxMode,
      );
    }

    if (applyDefaults || options.browserSourceSandboxTimeoutMs !== undefined) {
      this.browserSourceSandboxTimeoutMs = normalizePositiveInteger(
        options.browserSourceSandboxTimeoutMs,
        FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS,
      );
    }

    if (applyDefaults || options.browserSourceSandboxFailClosed !== undefined) {
      this.browserSourceSandboxFailClosed =
        options.browserSourceSandboxFailClosed ??
        FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED;
    }

    if (applyDefaults || options.enableDependencyPreflight !== undefined) {
      this.enableDependencyPreflight =
        options.enableDependencyPreflight ??
        FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT;
    }

    if (applyDefaults || options.failOnDependencyPreflightError !== undefined) {
      this.failOnDependencyPreflightError =
        options.failOnDependencyPreflightError ??
        FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR;
    }

    if (applyDefaults || options.remoteFetchTimeoutMs !== undefined) {
      this.remoteFetchTimeoutMs = normalizePositiveInteger(
        options.remoteFetchTimeoutMs,
        FALLBACK_REMOTE_FETCH_TIMEOUT_MS,
      );
    }

    if (applyDefaults || options.remoteFetchRetries !== undefined) {
      this.remoteFetchRetries = normalizeNonNegativeInteger(
        options.remoteFetchRetries,
        FALLBACK_REMOTE_FETCH_RETRIES,
      );
    }

    if (applyDefaults || options.remoteFetchBackoffMs !== undefined) {
      this.remoteFetchBackoffMs = normalizeNonNegativeInteger(
        options.remoteFetchBackoffMs,
        FALLBACK_REMOTE_FETCH_BACKOFF_MS,
      );
    }

    if (applyDefaults || options.remoteModuleMaxBytes !== undefined) {
      this.remoteModuleMaxBytes = normalizePositiveInteger(
        options.remoteModuleMaxBytes,
        FALLBACK_REMOTE_MODULE_MAX_BYTES,
      );
    }

    if (applyDefaults || options.remoteFallbackCdnBases !== undefined) {
      this.remoteFallbackCdnBases = normalizeFallbackCdnBases(
        options.remoteFallbackCdnBases,
      );
    }

    if (
      applyDefaults ||
      options.browserModuleUrlCacheMaxEntries !== undefined
    ) {
      this.browserModuleUrlCacheMaxEntries = normalizePositiveInteger(
        options.browserModuleUrlCacheMaxEntries,
        FALLBACK_BROWSER_MODULE_URL_CACHE_MAX_ENTRIES,
      );
    }

    if (
      applyDefaults ||
      options.runtimeSourceLocalSpecifierCacheMaxEntries !== undefined
    ) {
      this.runtimeSourceLocalSpecifierCacheMaxEntries =
        normalizePositiveInteger(
          options.runtimeSourceLocalSpecifierCacheMaxEntries,
          FALLBACK_RUNTIME_SOURCE_LOCAL_SPECIFIER_CACHE_MAX_ENTRIES,
        );
    }

    if (applyDefaults || options.allowArbitraryNetwork !== undefined) {
      this.allowArbitraryNetwork = options.allowArbitraryNetwork ?? true;
    }

    if (applyDefaults || options.allowedNetworkHosts !== undefined) {
      const normalizedHosts = this.normalizeAllowedNetworkHosts(
        options.allowedNetworkHosts,
      );
      this.allowedNetworkHosts = normalizedHosts.hosts;
      this.allowedNetworkHostMatchers = normalizedHosts.matchers;
    }

    if (networkPolicyChanged) {
      this.moduleLoader?.configureNetworkPolicy?.({
        allowArbitraryNetwork: this.allowArbitraryNetwork,
        isRemoteUrlAllowed: (url) => this.isRemoteUrlAllowed(url),
      });
    }
  }

  private normalizeAllowedNetworkHosts(hosts: string[] | undefined): {
    hosts: Set<string>;
    matchers: ParsedNetworkHostPattern[];
  } {
    const normalizedHosts = new Set<string>();
    const matchers: ParsedNetworkHostPattern[] = [];

    for (const entry of hosts ?? []) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim().toLowerCase();
      if (normalized.length === 0) {
        continue;
      }

      normalizedHosts.add(normalized);
      const pattern = parseNetworkHostPattern(normalized);
      if (pattern) {
        matchers.push(pattern);
      }
    }

    return {
      hosts: normalizedHosts,
      matchers,
    };
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

    if (plan.source && !this.allowRuntimeSourceExecution) {
      diagnostics.push(this.createSourceExecutionDisabledDiagnostic());
      return {
        planId: plan.id,
        diagnostics,
        dependencies: [],
      };
    }

    const capabilities = plan.capabilities ?? {};
    const executionProfile = this.resolveAvailableExecutionProfile(
      capabilities.executionProfile ?? this.defaultExecutionProfile,
      diagnostics,
    );
    if (!executionProfile) {
      return {
        planId: plan.id,
        diagnostics,
        dependencies: [],
      };
    }

    const frame: ExecutionFrame = {
      startedAt: nowMs(),
      maxExecutionMs: capabilities.maxExecutionMs ?? this.defaultMaxExecutionMs,
      maxComponentInvocations:
        capabilities.maxComponentInvocations ??
        this.defaultMaxComponentInvocations,
      componentInvocations: 0,
      executionProfile,
      materializationBudget: createRuntimeModuleMaterializationBudget(
        capabilities.maxImports ?? this.defaultMaxImports,
      ),
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
    throwIfRuntimeAborted(signal);

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

    if (plan.source && !this.allowRuntimeSourceExecution) {
      diagnostics.push(this.createSourceExecutionDisabledDiagnostic());
      return {
        planId: plan.id,
        root: plan.root,
        diagnostics,
        state: cloneJsonValue(this.resolveState(plan, stateOverride)),
        handledEvent: event,
        appliedActions: [],
      };
    }

    const capabilities = plan.capabilities ?? {};
    const executionProfile = this.resolveAvailableExecutionProfile(
      capabilities.executionProfile ?? this.defaultExecutionProfile,
      diagnostics,
    );
    const state = this.resolveState(plan, stateOverride);
    const appliedActions: RuntimeAction[] = [];
    if (!executionProfile) {
      return {
        planId: plan.id,
        root: plan.root,
        diagnostics,
        state: cloneJsonValue(state),
        handledEvent: event,
        appliedActions,
      };
    }

    this.applyEventTransitions({
      plan,
      state,
      context,
      event,
      appliedActions,
      diagnostics,
    });

    const maxImports = capabilities.maxImports ?? this.defaultMaxImports;
    const frame: ExecutionFrame = {
      startedAt: nowMs(),
      maxExecutionMs: capabilities.maxExecutionMs ?? this.defaultMaxExecutionMs,
      maxComponentInvocations:
        capabilities.maxComponentInvocations ??
        this.defaultMaxComponentInvocations,
      componentInvocations: 0,
      executionProfile,
      materializationBudget:
        createRuntimeModuleMaterializationBudget(maxImports),
      signal,
    };

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
        this.persistResolvedState(plan.id, state, stateOverride);
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

    // Dependency preflight can involve remote fetches and should not consume
    // the same execution budget used for actual module import + render.
    frame.startedAt = nowMs();

    await resolveRuntimePlanImports({
      imports,
      maxImports,
      moduleManifest: plan.moduleManifest,
      diagnostics,
      moduleLoader: this.createIntegrityAwareModuleLoader(
        plan.moduleManifest,
        diagnostics,
        frame.materializationBudget,
      ),
      resolveRuntimeSpecifier: (
        specifier,
        moduleManifest,
        runtimeDiagnostics,
      ) =>
        this.resolveRuntimeSpecifier(
          specifier,
          moduleManifest,
          runtimeDiagnostics,
          "import",
        ),
      isResolvedSpecifierAllowed: (specifier, runtimeDiagnostics) =>
        this.isResolvedSpecifierAllowed(
          specifier,
          "import",
          runtimeDiagnostics,
        ),
      isAborted: () => isRuntimeAborted(frame.signal),
      hasExceededBudget: () => hasRuntimeExceededBudget(frame),
      withRemainingBudget: (operation, timeoutMessage) =>
        withRuntimeRemainingBudget(operation, frame, timeoutMessage),
      isAbortError: (error) => isRuntimeAbortError(error),
      errorToMessage: (error) => this.errorToMessage(error),
    });

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

    this.persistResolvedState(plan.id, state, stateOverride);

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

    const persistedState = this.states.get(plan.id);
    if (persistedState) {
      return cloneJsonValue(persistedState);
    }

    if (plan.state?.initial) {
      return cloneJsonValue(plan.state.initial);
    }

    return {};
  }

  private applyEventTransitions(input: {
    plan: RuntimePlan;
    state: RuntimeStateSnapshot;
    context: RuntimeExecutionContext;
    event: RuntimeEvent | undefined;
    appliedActions: RuntimeAction[];
    diagnostics: RuntimeDiagnostic[];
  }): void {
    if (!input.event || !input.plan.state?.transitions) {
      return;
    }

    const transitions = input.plan.state.transitions;
    if (!Object.hasOwn(transitions, input.event.type)) {
      return;
    }

    const transitionActions = transitions[input.event.type];
    if (!transitionActions || transitionActions.length === 0) {
      return;
    }

    for (const action of transitionActions) {
      if (!isSafePath(action.path)) {
        input.diagnostics.push({
          level: "error",
          code: "RUNTIME_ACTION_PATH_UNSAFE",
          message: `Unsafe action path: ${action.path}`,
        });
        continue;
      }

      if (action.type === "set") {
        const resolvedValue = this.resolveActionValue(
          action.value,
          input.state,
          input.context,
          input.event,
        );
        setValueByPath(input.state, action.path, resolvedValue);
        input.appliedActions.push({
          type: "set",
          path: action.path,
          value: cloneJsonValue(resolvedValue),
        });
        continue;
      }

      if (action.type === "increment") {
        const by = action.by ?? 1;
        if (!Number.isFinite(by)) {
          input.diagnostics.push({
            level: "error",
            code: "RUNTIME_ACTION_INVALID",
            message: `Invalid increment delta for ${action.path}: ${String(action.by)}`,
          });
          continue;
        }

        const current = getValueByPath(input.state, action.path);
        const numericCurrent =
          typeof current === "number" && Number.isFinite(current) ? current : 0;
        setValueByPath(input.state, action.path, numericCurrent + by);
        input.appliedActions.push({
          type: "increment",
          path: action.path,
          by,
        });
        continue;
      }

      if (action.type === "toggle") {
        const current = getValueByPath(input.state, action.path);
        setValueByPath(input.state, action.path, !current);
        input.appliedActions.push({
          type: "toggle",
          path: action.path,
        });
        continue;
      }

      const resolvedValue = this.resolveActionValue(
        action.value,
        input.state,
        input.context,
        input.event,
      );
      const existing = getValueByPath(input.state, action.path);
      const nextArray: JsonValue[] = Array.isArray(existing)
        ? [...(existing as JsonValue[]), resolvedValue]
        : [resolvedValue];
      setValueByPath(input.state, action.path, nextArray);
      input.appliedActions.push({
        type: "push",
        path: action.path,
        value: cloneJsonValue(resolvedValue),
      });
    }
  }

  private resolveActionValue(
    value: RuntimeActionValue,
    state: RuntimeStateSnapshot,
    context: RuntimeExecutionContext,
    event: RuntimeEvent | undefined,
  ): JsonValue {
    const resolved = isRuntimeValueFromPath(value)
      ? this.resolveValueFromPath(value.$from, state, context, event)
      : value;
    return asJsonValue(resolved);
  }

  private resolveValueFromPath(
    sourcePath: string,
    state: RuntimeStateSnapshot,
    context: RuntimeExecutionContext,
    event: RuntimeEvent | undefined,
  ): unknown {
    const source = sourcePath.trim();
    if (source.startsWith("state.")) {
      return getValueByPath(state, source.slice(6));
    }
    if (source.startsWith("event.")) {
      return getValueByPath(event, source.slice(6));
    }
    if (source.startsWith("context.")) {
      return getValueByPath(context, source.slice(8));
    }
    if (source.startsWith("vars.")) {
      return getValueByPath(context.variables, source.slice(5));
    }

    return getValueByPath(state, source);
  }

  private resolveAvailableExecutionProfile(
    requestedProfile: RuntimeExecutionProfile,
    diagnostics: RuntimeDiagnostic[],
  ): RuntimeExecutionProfile | undefined {
    if (
      isBrowserSandboxExecutionProfile(requestedProfile) &&
      !isBrowserRuntime()
    ) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_ISOLATION_UNAVAILABLE",
        message: `executionProfile "${requestedProfile}" requires a browser sandbox backend; refusing execution before module loading because the current runtime is not a browser`,
      });
      return undefined;
    }

    if (requestedProfile !== "isolated-vm") {
      return requestedProfile;
    }

    if (this.allowIsolationFallback) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_ISOLATION_FALLBACK",
        message:
          'executionProfile "isolated-vm" has no secure isolation backend; allowIsolationFallback=true explicitly falls back to trusted "standard" execution',
      });
      return "standard";
    }

    diagnostics.push({
      level: "error",
      code: "RUNTIME_ISOLATION_UNAVAILABLE",
      message:
        'executionProfile "isolated-vm" has no secure isolation backend; refusing execution before module loading because allowIsolationFallback is false',
    });
    return undefined;
  }

  private persistResolvedState(
    planId: string,
    state: RuntimeStateSnapshot,
    stateOverride?: RuntimeStateSnapshot,
  ): void {
    if (stateOverride) {
      return;
    }

    this.states.set(planId, cloneJsonValue(state));
  }

  private async preflightPlanDependencies(
    plan: RuntimePlan,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<RuntimeDependencyProbeStatus[]> {
    return preflightRuntimePlanDependencies({
      plan,
      diagnostics,
      moduleLoader: this.createIntegrityAwareModuleLoader(
        plan.moduleManifest,
        diagnostics,
        frame.materializationBudget,
      ),
      withRemainingBudget: (operation, timeoutMessage) =>
        withRuntimeRemainingBudget(operation, frame, timeoutMessage),
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
      isResolvedSpecifierAllowed: (specifier, usage, runtimeDiagnostics) =>
        this.isResolvedSpecifierAllowed(specifier, usage, runtimeDiagnostics),
      probeRemoteSourceModule: (url, manifest, runtimeDiagnostics, signal) =>
        this.createSourceModuleLoader(
          manifest,
          runtimeDiagnostics,
          undefined,
          signal,
        ).probeRemoteModule(url, signal),
      isAbortError: (error) => isRuntimeAbortError(error),
      errorToMessage: (error) => this.errorToMessage(error),
      isAborted: () => isRuntimeAborted(frame.signal),
      hasExceededBudget: () => hasRuntimeExceededBudget(frame),
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
    return executeRuntimeSourceRoot({
      plan,
      source,
      context,
      state,
      event,
      diagnostics,
      frame: {
        executionProfile: frame.executionProfile,
        signal: frame.signal,
      },
      browserSourceSandboxTimeoutMs: this.browserSourceSandboxTimeoutMs,
      browserSourceSandboxFailClosed: this.browserSourceSandboxFailClosed,
      withRemainingBudget: (operation, timeoutMessage) =>
        withRuntimeRemainingBudget(operation, frame, timeoutMessage),
      transpileRuntimeSource: (runtimeSource) =>
        transpileRuntimeSource(
          runtimeSource,
          this.sourceTranspiler,
          this.runtimeSourceJsxHelperMode,
        ),
      rewriteSourceImports: async (code, manifest, runtimeDiagnostics) =>
        this.rewriteImportsAsync(code, async (specifier) =>
          this.resolveRuntimeSourceSpecifier(
            specifier,
            manifest,
            runtimeDiagnostics,
          ),
        ),
      resolveSourceSandboxMode: (runtimeSource, executionProfile) =>
        resolveSourceSandboxMode({
          source: runtimeSource,
          executionProfile,
          defaultMode: this.browserSourceSandboxMode,
          isBrowserRuntime: isBrowserRuntime(),
        }),
      importSourceModuleFromCode: (
        code,
        manifest,
        runtimeDiagnostics,
        signal,
      ) =>
        this.createSourceModuleLoader(
          manifest,
          runtimeDiagnostics,
          frame.materializationBudget,
          signal,
        ).importSourceModuleFromCode(code),
      normalizeSourceOutput: (output) => this.normalizeSourceOutput(output),
      shouldUsePreactSourceRuntime,
      createPreactRenderArtifact: async ({
        sourceExport,
        runtimeInput,
        diagnostics,
      }) => {
        const wrapWithEmotionCache =
          isNodeRuntime() && hasMaterialUiSourceImport(source.code);
        const emotionCacheBoundary = wrapWithEmotionCache
          ? await this.createEmotionCacheBoundary(diagnostics, frame)
          : undefined;
        return createPreactRenderArtifactFromComponentRuntime({
          sourceExport,
          runtimeInput,
          diagnostics,
          wrapWithEmotionCache,
          emotionCacheBoundary,
        });
      },
      isAbortError: (error) => isRuntimeAbortError(error),
      errorToMessage: (error) => this.errorToMessage(error),
      cloneJsonValue,
      asJsonValue,
    });
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

  private createSourceModuleLoader(
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    materializationBudget?: RuntimeModuleMaterializationBudget,
    signal?: AbortSignal,
  ): RuntimeSourceModuleLoader {
    return new RuntimeSourceModuleLoader({
      moduleManifest,
      diagnostics,
      materializedModuleUrlCache: this.browserModuleUrlCache,
      materializedModuleInflight: this.browserModuleInflight,
      remoteFallbackCdnBases: this.remoteFallbackCdnBases,
      remoteFetchTimeoutMs: this.remoteFetchTimeoutMs,
      remoteFetchRetries: this.remoteFetchRetries,
      remoteFetchBackoffMs: this.remoteFetchBackoffMs,
      remoteModuleMaxBytes: this.remoteModuleMaxBytes,
      materializedModuleUrlCacheMaxEntries:
        this.browserModuleUrlCacheMaxEntries,
      localNodeSpecifierUrlCacheMaxEntries:
        this.runtimeSourceLocalSpecifierCacheMaxEntries,
      materializationBudget,
      signal,
      canMaterializeRuntimeModules: () =>
        canMaterializeBrowserModules() || typeof Buffer !== "undefined",
      rewriteImportsAsync: (code, resolver) =>
        this.rewriteImportsAsync(code, resolver),
      createInlineModuleUrl: (code) => this.createInlineModuleUrl(code),
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
      isRemoteUrlAllowed: (url) => this.isRemoteUrlAllowed(url),
    });
  }

  private async createEmotionCacheBoundary(
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<{ provider: unknown; value: unknown } | undefined> {
    try {
      const namespace = (await this.createSourceModuleLoader(
        undefined,
        diagnostics,
        frame.materializationBudget,
        frame.signal,
      ).importSourceModuleFromCode(EMOTION_CACHE_BRIDGE_SOURCE)) as Record<
        string,
        unknown
      >;
      const provider = namespace.CacheProvider;
      const createCache = namespace.createCache;
      if (!provider || typeof createCache !== "function") {
        return undefined;
      }

      return {
        provider,
        value: createCache({ key: "renderify" }),
      };
    } catch (error) {
      this.pushDiagnosticOnce(diagnostics, {
        level: "error",
        code: "RUNTIME_EMOTION_CACHE_BRIDGE_FAILED",
        message: this.errorToMessage(error),
      });
      return undefined;
    }
  }

  private async materializeFetchedModuleSource(
    fetched: RemoteModuleFetchResult,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string> {
    return this.createSourceModuleLoader(
      moduleManifest,
      diagnostics,
    ).materializeFetchedModuleSource(fetched);
  }

  private async rewriteImportsAsync(
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ): Promise<string> {
    return rewriteImportsAsync(code, resolver);
  }

  private createInlineModuleUrl(code: string): string {
    if (isBrowserRuntime() && canMaterializeBrowserModules()) {
      return this.createBrowserBlobModuleUrl(code);
    }

    if (typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      return `data:text/javascript;base64,${encoded}`;
    }

    throw new Error("No runtime module URL strategy is available");
  }

  private createBrowserBlobModuleUrl(code: string): string {
    return createBrowserBlobModuleUrl(
      code,
      this.browserBlobUrls,
      this.browserBlobUrlsByCode,
    );
  }

  private revokeBrowserBlobUrls(): void {
    revokeBrowserBlobUrls(this.browserBlobUrls);
  }

  private normalizeSourceOutput(output: unknown): RuntimeNode | undefined {
    return normalizeRuntimeSourceOutput(output);
  }

  private isResolvedSpecifierAllowed(
    specifier: string,
    usage: "import" | "component" | "source-import",
    diagnostics: RuntimeDiagnostic[],
  ): boolean {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(specifier);
    } catch {
      return true;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return true;
    }

    if (this.isRemoteUrlAllowed(specifier)) {
      return true;
    }

    diagnostics.push({
      level: "error",
      code: "RUNTIME_NETWORK_POLICY_BLOCKED",
      message: `Blocked remote ${usage} specifier by runtime network policy: ${specifier}`,
    });
    return false;
  }

  private isRemoteUrlAllowed(url: string): boolean {
    if (this.allowArbitraryNetwork) {
      return true;
    }

    if (this.allowedNetworkHosts.size === 0) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return false;
    }

    return matchesAllowedNetworkUrl(parsedUrl, this.allowedNetworkHostMatchers);
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
    throwIfRuntimeAborted(frame.signal);

    if (hasRuntimeExceededBudget(frame)) {
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
        moduleLoader: this.createIntegrityAwareModuleLoader(
          moduleManifest,
          diagnostics,
          frame.materializationBudget,
        ),
        isResolvedSpecifierAllowed: (specifier, runtimeDiagnostics) =>
          this.isResolvedSpecifierAllowed(
            specifier,
            "component",
            runtimeDiagnostics,
          ),
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
          withRuntimeRemainingBudget(operation, frame, timeoutMessage),
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

  private createIntegrityAwareModuleLoader(
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    materializationBudget?: RuntimeModuleMaterializationBudget,
  ): RuntimeModuleLoader | undefined {
    const moduleLoader = this.moduleLoader;
    if (!moduleLoader) {
      return undefined;
    }

    return {
      load: async (specifier, signal) => {
        const expectedIntegrities = new Set<string>();
        for (const descriptor of Object.values(moduleManifest ?? {})) {
          if (
            descriptor.resolvedUrl.trim() === specifier.trim() &&
            descriptor.integrity?.trim()
          ) {
            expectedIntegrities.add(descriptor.integrity.trim());
          }
        }

        if (expectedIntegrities.size === 0 || !this.isHttpUrl(specifier)) {
          return loadRuntimeModuleWithBudget(moduleLoader, specifier, {
            materializationBudget,
            diagnostics,
            signal,
          });
        }

        if (expectedIntegrities.size > 1) {
          const message = `Conflicting integrity values for remote module: ${specifier}`;
          this.pushDiagnosticOnce(diagnostics, {
            level: "error",
            code: "RUNTIME_INTEGRITY_CONFLICT",
            message,
          });
          throw new Error(message);
        }

        const expectedIntegrity = expectedIntegrities.values().next().value;
        if (!expectedIntegrity) {
          return loadRuntimeModuleWithBudget(moduleLoader, specifier, {
            materializationBudget,
            diagnostics,
            signal,
          });
        }

        if (!moduleLoader.loadVerified) {
          const message = `Module loader cannot verify integrity-pinned remote module: ${specifier}`;
          this.pushDiagnosticOnce(diagnostics, {
            level: "error",
            code: "RUNTIME_INTEGRITY_LOADER_UNSUPPORTED",
            message,
          });
          throw new Error(message);
        }

        try {
          return await loadVerifiedRuntimeModuleWithBudget(
            moduleLoader,
            specifier,
            expectedIntegrity,
            {
              materializationBudget,
              diagnostics,
              signal,
            },
          );
        } catch (error) {
          if (isRuntimeModuleIntegrityError(error)) {
            this.pushDiagnosticOnce(diagnostics, {
              level: "error",
              code: "RUNTIME_INTEGRITY_MISMATCH",
              message: `Module integrity mismatch: ${specifier}`,
            });
          }
          throw error;
        }
      },
      ...(moduleLoader.unload
        ? {
            unload: (specifier) =>
              moduleLoader.unload?.call(moduleLoader, specifier) ??
              Promise.resolve(),
          }
        : {}),
    };
  }

  private isHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private pushDiagnosticOnce(
    diagnostics: RuntimeDiagnostic[],
    diagnostic: RuntimeDiagnostic,
  ): void {
    if (
      diagnostics.some(
        (item) =>
          item.code === diagnostic.code && item.message === diagnostic.message,
      )
    ) {
      return;
    }
    diagnostics.push(diagnostic);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("RuntimeManager is not initialized");
    }
  }

  private createSourceExecutionDisabledDiagnostic(): RuntimeDiagnostic {
    return {
      level: "error",
      code: "RUNTIME_SOURCE_EXECUTION_DISABLED",
      message:
        "Runtime source execution is disabled; set allowRuntimeSourceExecution to true only for trusted plans",
    };
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

function isBrowserSandboxExecutionProfile(
  profile: RuntimeExecutionProfile,
): boolean {
  return (
    profile === "sandbox-worker" ||
    profile === "sandbox-iframe" ||
    profile === "sandbox-shadowrealm"
  );
}

function hasMaterialUiSourceImport(code: string): boolean {
  return /(?:from\s+|import\s*\(\s*)["']@mui\/(?:material|icons-material)(?:@[^/"']+)?(?:\/[^"']+)?["']/.test(
    code,
  );
}
