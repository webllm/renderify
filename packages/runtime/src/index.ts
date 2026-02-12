import {
  asJsonValue,
  cloneJsonValue,
  collectComponentModules,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  getValueByPath,
  isRuntimeNode,
  isRuntimeValueFromPath,
  type JsonValue,
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
  setValueByPath,
} from "@renderify/ir";
import {
  init as initModuleLexer,
  parse as parseModuleImports,
} from "es-module-lexer";

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
}

export type RuntimeDependencyUsage = "import" | "component" | "source-import";

export interface RuntimeDependencyProbeStatus {
  usage: RuntimeDependencyUsage;
  specifier: string;
  resolvedSpecifier?: string;
  ok: boolean;
  message?: string;
}

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

interface ExecutionFrame {
  startedAt: number;
  maxExecutionMs: number;
  maxComponentInvocations: number;
  componentInvocations: number;
  executionProfile: RuntimeExecutionProfile;
}

interface ResolvedSourceOutput {
  root?: RuntimeNode;
  renderArtifact?: RuntimeRenderArtifact;
}

interface DependencyProbe {
  usage: RuntimeDependencyUsage;
  specifier: string;
}

interface RemoteModuleFetchResult {
  url: string;
  code: string;
  contentType: string;
  requestUrl: string;
}

export type RuntimeComponentFactory = (
  props: Record<string, JsonValue>,
  context: RuntimeExecutionContext,
  children: RuntimeNode[],
) => Promise<RuntimeNode | string> | RuntimeNode | string;

const FALLBACK_MAX_IMPORTS = 50;
const FALLBACK_MAX_COMPONENT_INVOCATIONS = 200;
const FALLBACK_MAX_EXECUTION_MS = 1500;
const FALLBACK_EXECUTION_PROFILE: RuntimeExecutionProfile = "standard";
const FALLBACK_JSPM_CDN_BASE = "https://ga.jspm.io/npm";
const FALLBACK_ESM_CDN_BASE = "https://esm.sh";
const FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT = true;
const FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR = false;
const FALLBACK_REMOTE_FETCH_TIMEOUT_MS = 12_000;
const FALLBACK_REMOTE_FETCH_RETRIES = 2;
const FALLBACK_REMOTE_FETCH_BACKOFF_MS = 150;
const FALLBACK_REMOTE_FALLBACK_CDN_BASES = [FALLBACK_ESM_CDN_BASE];
const FALLBACK_SUPPORTED_SPEC_VERSIONS = [DEFAULT_RUNTIME_PLAN_SPEC_VERSION];
const FALLBACK_ENFORCE_MODULE_MANIFEST = true;
const FALLBACK_ALLOW_ISOLATION_FALLBACK = false;
const SOURCE_IMPORT_REWRITE_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

interface BabelStandaloneLike {
  transform(
    code: string,
    options: {
      sourceType?: "module";
      presets?: unknown[];
      filename?: string;
      babelrc?: boolean;
      configFile?: boolean;
      comments?: boolean;
    },
  ): {
    code?: string;
  };
}

const RUNTIME_JSX_HELPERS = `
function __renderify_runtime_to_nodes(value) {
  if (value === null || value === undefined || value === false || value === true) {
    return [];
  }
  if (Array.isArray(value)) {
    const flattened = [];
    for (const entry of value) {
      flattened.push(...__renderify_runtime_to_nodes(entry));
    }
    return flattened;
  }
  if (typeof value === "string" || typeof value === "number") {
    return [{ type: "text", value: String(value) }];
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  ) {
    return [value];
  }
  return [{ type: "text", value: String(value) }];
}

function __renderify_runtime_h(type, props, ...children) {
  const normalizedChildren = __renderify_runtime_to_nodes(children);
  if (typeof type === "function") {
    const output = type({ ...(props || {}), children: normalizedChildren });
    const functionNodes = __renderify_runtime_to_nodes(output);
    if (functionNodes.length === 1) {
      return functionNodes[0];
    }
    return { type: "element", tag: "div", children: functionNodes };
  }
  if (typeof type === "string") {
    return {
      type: "element",
      tag: type,
      props: props || undefined,
      children: normalizedChildren,
    };
  }
  return { type: "text", value: "Unsupported JSX node type" };
}

function __renderify_runtime_fragment(...children) {
  return __renderify_runtime_to_nodes(children);
}
`.trim();

export class BabelRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    if (input.language === "js") {
      return input.code;
    }

    const babel = this.resolveBabel();
    const presets: unknown[] = [];

    if (input.language === "ts" || input.language === "tsx") {
      presets.push("typescript");
    }

    if (input.language === "jsx" || input.language === "tsx") {
      if (input.runtime === "preact") {
        presets.push([
          "react",
          {
            runtime: "automatic",
            importSource: "preact",
          },
        ]);
      } else {
        presets.push([
          "react",
          {
            runtime: "classic",
            pragma: "__renderify_runtime_h",
            pragmaFrag: "__renderify_runtime_fragment",
          },
        ]);
      }
    }

    const transformed = babel.transform(input.code, {
      sourceType: "module",
      presets,
      filename: input.filename,
      babelrc: false,
      configFile: false,
      comments: false,
    });

    if (!transformed.code) {
      throw new Error("Babel returned empty output");
    }

    return transformed.code;
  }

  private resolveBabel(): BabelStandaloneLike {
    const root = globalThis as unknown as {
      Babel?: BabelStandaloneLike;
    };

    if (root.Babel && typeof root.Babel.transform === "function") {
      return root.Babel;
    }

    throw new Error(
      "Babel standalone is not available. Load @babel/standalone in browser or provide sourceTranspiler.",
    );
  }
}

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
    this.supportedPlanSpecVersions = this.normalizeSupportedSpecVersions(
      options.supportedPlanSpecVersions,
    );
    this.enforceModuleManifest =
      options.enforceModuleManifest ?? FALLBACK_ENFORCE_MODULE_MANIFEST;
    this.allowIsolationFallback =
      options.allowIsolationFallback ?? FALLBACK_ALLOW_ISOLATION_FALLBACK;
    this.enableDependencyPreflight =
      options.enableDependencyPreflight ?? FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT;
    this.failOnDependencyPreflightError =
      options.failOnDependencyPreflightError ??
      FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR;
    this.remoteFetchTimeoutMs = this.normalizePositiveInteger(
      options.remoteFetchTimeoutMs,
      FALLBACK_REMOTE_FETCH_TIMEOUT_MS,
    );
    this.remoteFetchRetries = this.normalizeNonNegativeInteger(
      options.remoteFetchRetries,
      FALLBACK_REMOTE_FETCH_RETRIES,
    );
    this.remoteFetchBackoffMs = this.normalizeNonNegativeInteger(
      options.remoteFetchBackoffMs,
      FALLBACK_REMOTE_FETCH_BACKOFF_MS,
    );
    this.remoteFallbackCdnBases = this.normalizeFallbackCdnBases(
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
  ): Promise<RuntimeExecutionResult> {
    this.ensureInitialized();

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
        this.applyAction(action, state, event, context);
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
    const probes = await this.collectDependencyProbes(plan);
    const statuses: RuntimeDependencyProbeStatus[] = [];

    for (const probe of probes) {
      if (this.hasExceededBudget(frame)) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_TIMEOUT",
          message: `Execution time budget exceeded during dependency preflight (${probe.usage}:${probe.specifier})`,
        });
        statuses.push({
          usage: probe.usage,
          specifier: probe.specifier,
          ok: false,
          message: "Dependency preflight timed out",
        });
        return statuses;
      }

      const status = await this.preflightDependencyProbe(
        probe,
        plan.moduleManifest,
        diagnostics,
        frame,
      );
      statuses.push(status);
    }

    return statuses;
  }

  private async collectDependencyProbes(
    plan: RuntimePlan,
  ): Promise<DependencyProbe[]> {
    const probes: DependencyProbe[] = [];
    const seen = new Set<string>();

    const pushProbe = (usage: RuntimeDependencyUsage, specifier: string) => {
      const trimmed = specifier.trim();
      if (trimmed.length === 0) {
        return;
      }

      const key = `${usage}:${trimmed}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      probes.push({
        usage,
        specifier: trimmed,
      });
    };

    for (const specifier of plan.imports ?? []) {
      pushProbe("import", specifier);
    }

    for (const specifier of collectComponentModules(plan.root)) {
      pushProbe("component", specifier);
    }

    if (plan.source) {
      const sourceImports = await this.parseSourceImportSpecifiers(
        plan.source.code,
      );
      for (const specifier of sourceImports) {
        pushProbe("source-import", specifier);
      }
    }

    return probes;
  }

  private async parseSourceImportSpecifiers(code: string): Promise<string[]> {
    if (code.trim().length === 0) {
      return [];
    }

    const imports = new Set<string>();
    const parsedSpecifiers = await this.parseImportSpecifiersFromSource(code);
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
    if (probe.usage === "source-import") {
      const resolved = this.resolveRuntimeSourceSpecifier(
        probe.specifier,
        moduleManifest,
        diagnostics,
        false,
      );

      if (
        resolved.startsWith("./") ||
        resolved.startsWith("../") ||
        resolved.startsWith("/")
      ) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_PREFLIGHT_SOURCE_IMPORT_RELATIVE_UNRESOLVED",
          message: `Runtime source entry import must resolve to URL or bare package alias: ${probe.specifier}`,
        });
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: false,
          message: "Relative source import could not be resolved",
        };
      }

      const timeoutMessage = `Dependency preflight timed out: ${probe.specifier}`;
      const loaderCandidate = this.resolveSourceImportLoaderCandidate(
        probe.specifier,
        moduleManifest,
      );

      try {
        if (this.moduleLoader && loaderCandidate) {
          await this.withRemainingBudget(
            () => this.moduleLoader!.load(loaderCandidate),
            frame,
            timeoutMessage,
          );
          return {
            usage: probe.usage,
            specifier: probe.specifier,
            resolvedSpecifier: loaderCandidate,
            ok: true,
          };
        }

        if (this.isHttpUrl(resolved)) {
          await this.withRemainingBudget(
            async () => {
              if (this.canMaterializeBrowserModules()) {
                await this.materializeBrowserRemoteModule(
                  resolved,
                  moduleManifest,
                  diagnostics,
                );
              } else {
                await this.fetchRemoteModuleCodeWithFallback(
                  resolved,
                  diagnostics,
                );
              }
            },
            frame,
            timeoutMessage,
          );
          return {
            usage: probe.usage,
            specifier: probe.specifier,
            resolvedSpecifier: resolved,
            ok: true,
          };
        }

        if (!this.moduleLoader) {
          diagnostics.push({
            level: "warning",
            code: "RUNTIME_PREFLIGHT_SKIPPED",
            message: `Dependency preflight skipped (no module loader): ${probe.usage}:${resolved}`,
          });
          return {
            usage: probe.usage,
            specifier: probe.specifier,
            resolvedSpecifier: resolved,
            ok: false,
            message:
              "Dependency preflight skipped because source import is not loadable without module loader",
          };
        }

        await this.withRemainingBudget(
          () => this.moduleLoader!.load(resolved),
          frame,
          timeoutMessage,
        );
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: true,
        };
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_PREFLIGHT_SOURCE_IMPORT_FAILED",
          message: `${probe.specifier}: ${this.errorToMessage(error)}`,
        });
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: false,
          message: this.errorToMessage(error),
        };
      }
    }

    const resolved = this.resolveRuntimeSpecifier(
      probe.specifier,
      moduleManifest,
      diagnostics,
      probe.usage,
    );
    if (!resolved) {
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        ok: false,
        message: "Module manifest resolution failed",
      };
    }

    if (!this.moduleLoader) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_PREFLIGHT_SKIPPED",
        message: `Dependency preflight skipped (no module loader): ${probe.usage}:${resolved}`,
      });
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: false,
        message:
          "Dependency preflight skipped because module loader is missing",
      };
    }

    try {
      await this.withRemainingBudget(
        () => this.moduleLoader!.load(resolved),
        frame,
        `Dependency preflight timed out: ${resolved}`,
      );
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: true,
      };
    } catch (error) {
      diagnostics.push({
        level: "error",
        code:
          probe.usage === "component"
            ? "RUNTIME_PREFLIGHT_COMPONENT_FAILED"
            : "RUNTIME_PREFLIGHT_IMPORT_FAILED",
        message: `${resolved}: ${this.errorToMessage(error)}`,
      });
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: false,
        message: this.errorToMessage(error),
      };
    }
  }

  private applyAction(
    action: RuntimeAction,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent,
    context: RuntimeExecutionContext,
  ): void {
    if (action.type === "set") {
      const next = this.resolveActionValue(action.value, state, event, context);
      setValueByPath(state, action.path, next);
      return;
    }

    if (action.type === "increment") {
      const current = getValueByPath(state, action.path);
      const currentNumber = typeof current === "number" ? current : 0;
      const by = action.by ?? 1;
      setValueByPath(state, action.path, asJsonValue(currentNumber + by));
      return;
    }

    if (action.type === "toggle") {
      const current = getValueByPath(state, action.path);
      const next = typeof current === "boolean" ? !current : true;
      setValueByPath(state, action.path, next);
      return;
    }

    const next = this.resolveActionValue(action.value, state, event, context);
    const current = getValueByPath(state, action.path);

    if (Array.isArray(current)) {
      setValueByPath(state, action.path, [...current, next]);
      return;
    }

    setValueByPath(state, action.path, [next]);
  }

  private resolveActionValue(
    value: JsonValue | { $from: string },
    state: RuntimeStateSnapshot,
    event: RuntimeEvent,
    context: RuntimeExecutionContext,
  ): JsonValue {
    if (!isRuntimeValueFromPath(value)) {
      return value;
    }

    const sourcePath = value.$from.trim();
    if (sourcePath.startsWith("state.")) {
      return asJsonValue(getValueByPath(state, sourcePath.slice(6)));
    }

    if (sourcePath.startsWith("event.")) {
      return asJsonValue(getValueByPath(event, sourcePath.slice(6)));
    }

    if (sourcePath.startsWith("context.")) {
      return asJsonValue(getValueByPath(context, sourcePath.slice(8)));
    }

    if (sourcePath.startsWith("vars.")) {
      return asJsonValue(
        getValueByPath(context.variables, sourcePath.slice(5)),
      );
    }

    return asJsonValue(getValueByPath(state, sourcePath));
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

      const exportName = source.exportName ?? "default";
      const selected = this.selectExport(namespace, exportName);
      if (selected === undefined) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_SOURCE_EXPORT_MISSING",
          message: `Runtime source export "${exportName}" is missing`,
        });
        return undefined;
      }

      const runtimeInput = {
        context: cloneJsonValue(asJsonValue(context)),
        state: cloneJsonValue(state),
        event: event ? cloneJsonValue(asJsonValue(event)) : null,
      };

      if (this.shouldUsePreactSourceRuntime(source)) {
        const preactArtifact = await this.createPreactRenderArtifact(
          selected,
          runtimeInput,
          diagnostics,
        );
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
      diagnostics.push({
        level: "error",
        code: "RUNTIME_SOURCE_EXEC_FAILED",
        message: this.errorToMessage(error),
      });
      return undefined;
    }
  }

  private async transpileRuntimeSource(
    source: RuntimeSourceModule,
  ): Promise<string> {
    const mergedSource =
      source.runtime === "preact"
        ? source.code
        : `${source.code}\n\n${RUNTIME_JSX_HELPERS}`;
    return this.sourceTranspiler.transpile({
      code: mergedSource,
      language: source.language,
      filename: `renderify-runtime-source.${source.language}`,
      runtime: source.runtime,
    });
  }

  private async createPreactRenderArtifact(
    sourceExport: unknown,
    runtimeInput: Record<string, JsonValue>,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<RuntimeRenderArtifact | undefined> {
    const preact = await this.loadPreactModule();
    if (!preact) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_PREACT_UNAVAILABLE",
        message:
          "source.runtime=preact requested but preact runtime is unavailable",
      });
      return undefined;
    }

    if (this.isPreactLikeVNode(sourceExport)) {
      return {
        mode: "preact-vnode",
        payload: sourceExport,
      };
    }

    if (typeof sourceExport !== "function") {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_PREACT_EXPORT_INVALID",
        message: "source.runtime=preact requires a component export function",
      });
      return undefined;
    }

    try {
      const vnode = preact.h(
        sourceExport as (props: Record<string, JsonValue>) => unknown,
        runtimeInput,
      );

      return {
        mode: "preact-vnode",
        payload: vnode,
      };
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_PREACT_VNODE_FAILED",
        message: this.errorToMessage(error),
      });
      return undefined;
    }
  }

  private shouldUsePreactSourceRuntime(source: RuntimeSourceModule): boolean {
    if (source.runtime === "preact") {
      return true;
    }

    return (
      source.runtime === undefined &&
      (source.language === "tsx" || source.language === "jsx")
    );
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
    const trimmed = specifier.trim();
    const manifestResolved = this.resolveOptionalManifestSpecifier(
      trimmed,
      moduleManifest,
    );

    if (manifestResolved && manifestResolved !== trimmed) {
      return this.resolveSourceSpecifierWithLoader(manifestResolved);
    }

    if (!this.shouldRewriteSpecifier(trimmed)) {
      return manifestResolved ?? trimmed;
    }

    const resolvedFromPolicy = requireManifest
      ? this.resolveRuntimeSpecifier(
          trimmed,
          moduleManifest,
          diagnostics,
          "source-import",
        )
      : manifestResolved;

    if (!resolvedFromPolicy) {
      return trimmed;
    }

    const loaderResolved =
      this.resolveSourceSpecifierWithLoader(resolvedFromPolicy);
    if (loaderResolved !== resolvedFromPolicy) {
      return loaderResolved;
    }

    if (resolvedFromPolicy.startsWith("npm:")) {
      return `${FALLBACK_JSPM_CDN_BASE}/${resolvedFromPolicy.slice(4)}`;
    }

    if (this.isDirectSpecifier(resolvedFromPolicy)) {
      return resolvedFromPolicy;
    }

    if (this.isBareSpecifier(resolvedFromPolicy)) {
      return `${FALLBACK_JSPM_CDN_BASE}/npm:${resolvedFromPolicy}`;
    }

    return `${FALLBACK_JSPM_CDN_BASE}/${resolvedFromPolicy}`;
  }

  private resolveSourceSpecifierWithLoader(specifier: string): string {
    if (this.moduleLoader && this.hasResolveSpecifier(this.moduleLoader)) {
      try {
        return this.moduleLoader.resolveSpecifier(specifier);
      } catch {
        // fall through to default resolver
      }
    }

    return specifier;
  }

  private resolveSourceImportLoaderCandidate(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): string | undefined {
    const manifestResolved = this.resolveOptionalManifestSpecifier(
      specifier,
      moduleManifest,
    );
    const candidate = (manifestResolved ?? specifier).trim();
    if (candidate.length === 0) {
      return undefined;
    }

    if (
      candidate.startsWith("./") ||
      candidate.startsWith("../") ||
      candidate.startsWith("/")
    ) {
      return undefined;
    }

    return this.resolveSourceSpecifierWithLoader(candidate);
  }

  private resolveOptionalManifestSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): string | undefined {
    const descriptor = moduleManifest?.[specifier];
    if (!descriptor) {
      return specifier;
    }

    const resolved = descriptor.resolvedUrl.trim();
    if (resolved.length === 0) {
      return undefined;
    }

    return resolved;
  }

  private shouldRewriteSpecifier(specifier: string): boolean {
    if (this.isDirectSpecifier(specifier)) {
      return false;
    }

    return true;
  }

  private isDirectSpecifier(specifier: string): boolean {
    return (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/") ||
      specifier.startsWith("http://") ||
      specifier.startsWith("https://") ||
      specifier.startsWith("blob:") ||
      specifier.startsWith("data:")
    );
  }

  private isHttpUrl(specifier: string): boolean {
    return specifier.startsWith("http://") || specifier.startsWith("https://");
  }

  private isBareSpecifier(specifier: string): boolean {
    return !this.isDirectSpecifier(specifier) && !specifier.startsWith("npm:");
  }

  private resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    usage: "import" | "component" | "source-import",
  ): string | undefined {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_MANIFEST_INVALID",
        message: `Empty ${usage} specifier`,
      });
      return undefined;
    }

    const descriptor = moduleManifest?.[trimmed];
    if (descriptor) {
      const resolved = descriptor.resolvedUrl.trim();
      if (resolved.length === 0) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_MANIFEST_INVALID",
          message: `Manifest entry has empty resolvedUrl for ${trimmed}`,
        });
        return undefined;
      }

      return resolved;
    }

    if (!this.enforceModuleManifest || this.isDirectSpecifier(trimmed)) {
      return trimmed;
    }

    diagnostics.push({
      level: "error",
      code: "RUNTIME_MANIFEST_MISSING",
      message: `Missing moduleManifest entry for ${usage}: ${trimmed}`,
    });
    return undefined;
  }

  private hasResolveSpecifier(
    loader: RuntimeModuleLoader,
  ): loader is RuntimeModuleLoader & {
    resolveSpecifier(specifier: string): string;
  } {
    return (
      typeof loader === "object" &&
      loader !== null &&
      "resolveSpecifier" in loader &&
      typeof (loader as { resolveSpecifier?: unknown }).resolveSpecifier ===
        "function"
    );
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
    return (
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function" &&
      typeof Blob !== "undefined" &&
      typeof fetch === "function"
    );
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

    if (this.isHttpUrl(trimmed)) {
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
      if (!parentUrl || !this.isHttpUrl(parentUrl)) {
        diagnostics.push({
          level: "warning",
          code: "RUNTIME_SOURCE_IMPORT_UNRESOLVED",
          message: `Cannot resolve relative source import without parent URL: ${trimmed}`,
        });
        return trimmed;
      }

      const absolute = new URL(trimmed, parentUrl).toString();
      if (!this.isHttpUrl(absolute)) {
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

    if (this.isHttpUrl(resolved)) {
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
      this.isHttpUrl(parentUrl)
    ) {
      const absolute = new URL(resolved, parentUrl).toString();
      if (!this.isHttpUrl(absolute)) {
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
    const candidates = new Set<string>();
    candidates.add(url);

    for (const fallbackBase of this.remoteFallbackCdnBases) {
      const fallback = this.toConfiguredFallbackUrl(url, fallbackBase);
      if (fallback) {
        candidates.add(fallback);
      }
    }

    return [...candidates];
  }

  private toConfiguredFallbackUrl(
    url: string,
    cdnBase: string,
  ): string | undefined {
    const normalizedBase = cdnBase.trim().replace(/\/$/, "");
    const specifier = this.extractJspmNpmSpecifier(url);
    if (!specifier || normalizedBase.length === 0) {
      return undefined;
    }

    if (normalizedBase.includes("esm.sh")) {
      return this.toEsmFallbackUrl(url, normalizedBase);
    }

    if (normalizedBase.includes("jsdelivr.net")) {
      return `${normalizedBase}/npm/${specifier}`;
    }

    if (normalizedBase.includes("unpkg.com")) {
      const separator = specifier.includes("?") ? "&" : "?";
      return `${normalizedBase}/${specifier}${separator}module`;
    }

    if (normalizedBase.includes("jspm.io")) {
      const root = normalizedBase.endsWith("/npm")
        ? normalizedBase.slice(0, normalizedBase.length - 4)
        : normalizedBase;
      return `${root}/npm:${specifier}`;
    }

    return undefined;
  }

  private toEsmFallbackUrl(
    url: string,
    cdnBase = FALLBACK_ESM_CDN_BASE,
  ): string | undefined {
    const specifier = this.extractJspmNpmSpecifier(url);
    if (!specifier) {
      return undefined;
    }
    const normalizedBase = cdnBase.trim().replace(/\/$/, "");
    if (normalizedBase.length === 0) {
      return undefined;
    }

    const aliasQuery = [
      "alias=react:preact/compat,react-dom:preact/compat,react-dom/client:preact/compat,react/jsx-runtime:preact/jsx-runtime,react/jsx-dev-runtime:preact/jsx-runtime",
      "target=es2022",
    ].join("&");

    const separator = specifier.includes("?") ? "&" : "?";
    return `${normalizedBase}/${specifier}${separator}${aliasQuery}`;
  }

  private extractJspmNpmSpecifier(url: string): string | undefined {
    const prefix = "https://ga.jspm.io/npm:";
    if (!url.startsWith(prefix)) {
      return undefined;
    }

    const specifier = url.slice(prefix.length).trim();
    if (specifier.length === 0) {
      return undefined;
    }

    return specifier;
  }

  private isCssModuleResponse(fetched: RemoteModuleFetchResult): boolean {
    return (
      fetched.contentType.includes("text/css") || this.isCssUrl(fetched.url)
    );
  }

  private isJsonModuleResponse(fetched: RemoteModuleFetchResult): boolean {
    return (
      fetched.contentType.includes("application/json") ||
      fetched.contentType.includes("text/json") ||
      this.isJsonUrl(fetched.url)
    );
  }

  private isJavaScriptModuleResponse(
    fetched: RemoteModuleFetchResult,
  ): boolean {
    if (this.isJavaScriptLikeContentType(fetched.contentType)) {
      return true;
    }

    return this.isJavaScriptUrl(fetched.url);
  }

  private isJavaScriptLikeContentType(contentType: string): boolean {
    return (
      contentType.includes("javascript") ||
      contentType.includes("ecmascript") ||
      contentType.includes("typescript") ||
      contentType.includes("module")
    );
  }

  private isBinaryLikeContentType(contentType: string): boolean {
    return (
      contentType.includes("application/wasm") ||
      contentType.includes("image/") ||
      contentType.includes("font/")
    );
  }

  private isJavaScriptUrl(url: string): boolean {
    const pathname = this.toUrlPathname(url);
    return /\.(?:m?js|cjs|jsx|ts|tsx)$/i.test(pathname);
  }

  private isCssUrl(url: string): boolean {
    const pathname = this.toUrlPathname(url);
    return /\.css$/i.test(pathname);
  }

  private isJsonUrl(url: string): boolean {
    const pathname = this.toUrlPathname(url);
    return /\.json$/i.test(pathname);
  }

  private toUrlPathname(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  private createCssProxyModuleSource(
    cssText: string,
    sourceUrl: string,
  ): string {
    const styleId = `renderify-css-${this.hashString(sourceUrl)}`;
    const cssLiteral = JSON.stringify(cssText);
    const styleIdLiteral = JSON.stringify(styleId);
    return [
      "const __css = " + cssLiteral + ";",
      "const __styleId = " + styleIdLiteral + ";",
      'if (typeof document !== "undefined") {',
      "  let __style = null;",
      '  const __styles = document.querySelectorAll("style[data-renderify-style-id]");',
      "  for (const __candidate of __styles) {",
      '    if (__candidate.getAttribute("data-renderify-style-id") === __styleId) {',
      "      __style = __candidate;",
      "      break;",
      "    }",
      "  }",
      "  if (!__style) {",
      '    __style = document.createElement("style");',
      '    __style.setAttribute("data-renderify-style-id", __styleId);',
      "    __style.textContent = __css;",
      "    document.head.appendChild(__style);",
      "  }",
      "}",
      "export default __css;",
      "export const cssText = __css;",
    ].join("\n");
  }

  private createJsonProxyModuleSource(
    fetched: RemoteModuleFetchResult,
    diagnostics: RuntimeDiagnostic[],
  ): string {
    try {
      const parsed = JSON.parse(fetched.code) as unknown;
      return [
        `const __json = ${JSON.stringify(parsed)};`,
        "export default __json;",
      ].join("\n");
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
    return [
      `const __text = ${JSON.stringify(text)};`,
      "export default __text;",
      "export const text = __text;",
    ].join("\n");
  }

  private createUrlProxyModuleSource(url: string): string {
    return [
      `const __assetUrl = ${JSON.stringify(url)};`,
      "export default __assetUrl;",
      "export const assetUrl = __assetUrl;",
    ].join("\n");
  }

  private hashString(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<Response> {
    if (typeof AbortController === "undefined") {
      return fetch(url);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(url, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async rewriteImportsAsync(
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ): Promise<string> {
    const imports = await this.parseImportSpecifiersFromSource(code);
    if (imports.length === 0) {
      return code;
    }

    let rewritten = "";
    let cursor = 0;

    for (const item of imports) {
      rewritten += code.slice(cursor, item.start);
      rewritten += await resolver(item.specifier);
      cursor = item.end;
    }

    rewritten += code.slice(cursor);
    return rewritten;
  }

  private async parseImportSpecifiersFromSource(
    source: string,
  ): Promise<Array<{ start: number; end: number; specifier: string }>> {
    if (source.trim().length === 0) {
      return [];
    }

    try {
      await initModuleLexer;
      const [imports] = parseModuleImports(source);
      const parsed: Array<{ start: number; end: number; specifier: string }> =
        [];

      for (const item of imports) {
        const specifier = item.n?.trim();
        if (!specifier) {
          continue;
        }

        if (item.s < 0 || item.e <= item.s) {
          continue;
        }

        parsed.push({
          start: item.s,
          end: item.e,
          specifier,
        });
      }

      return parsed.sort((left, right) => left.start - right.start);
    } catch {
      return this.parseImportSpecifiersFromRegex(source);
    }
  }

  private parseImportSpecifiersFromRegex(
    source: string,
  ): Array<{ start: number; end: number; specifier: string }> {
    const parsed = new Map<
      string,
      { start: number; end: number; specifier: string }
    >();

    for (const pattern of SOURCE_IMPORT_REWRITE_PATTERNS) {
      const regex = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );

      let match = regex.exec(source);
      while (match) {
        const fullMatch = String(match[0] ?? "");
        const capturedSpecifier = String(match[1] ?? "").trim();
        if (capturedSpecifier.length === 0) {
          match = regex.exec(source);
          continue;
        }

        const relativeIndex = fullMatch.indexOf(capturedSpecifier);
        if (relativeIndex < 0) {
          match = regex.exec(source);
          continue;
        }

        const start = match.index + relativeIndex;
        const end = start + capturedSpecifier.length;
        parsed.set(`${start}:${end}`, {
          start,
          end,
          specifier: capturedSpecifier,
        });

        match = regex.exec(source);
      }
    }

    return [...parsed.values()].sort((left, right) => left.start - right.start);
  }

  private createBrowserBlobModuleUrl(code: string): string {
    const blobUrl = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" }),
    );
    this.browserBlobUrls.add(blobUrl);
    return blobUrl;
  }

  private revokeBrowserBlobUrls(): void {
    if (
      typeof URL === "undefined" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      this.browserBlobUrls.clear();
      return;
    }

    for (const blobUrl of this.browserBlobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.browserBlobUrls.clear();
  }

  private normalizeSourceOutput(output: unknown): RuntimeNode | undefined {
    if (isRuntimeNode(output)) {
      return output;
    }

    if (typeof output === "string" || typeof output === "number") {
      return createTextNode(String(output));
    }

    if (Array.isArray(output)) {
      const normalizedChildren = output
        .map((entry) => this.normalizeSourceOutput(entry))
        .filter((entry): entry is RuntimeNode => entry !== undefined);

      return createElementNode(
        "div",
        { "data-renderify-fragment": "true" },
        normalizedChildren,
      );
    }

    return undefined;
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

    if (node.type === "text") {
      return createTextNode(
        this.interpolateTemplate(node.value, context, state, event),
      );
    }

    const resolvedChildren = await this.resolveChildren(
      node.children ?? [],
      moduleManifest,
      context,
      state,
      event,
      diagnostics,
      frame,
    );

    if (node.type === "element") {
      return {
        ...node,
        props: this.resolveProps(node.props, context, state, event),
        children: resolvedChildren,
      };
    }

    if (frame.componentInvocations >= frame.maxComponentInvocations) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_COMPONENT_LIMIT_EXCEEDED",
        message: `Component invocation limit exceeded: ${frame.maxComponentInvocations}`,
      });
      return createElementNode(
        "div",
        { "data-renderify-component-limit": node.module },
        [createTextNode("Component invocation limit exceeded")],
      );
    }

    frame.componentInvocations += 1;

    const resolvedComponentSpecifier = this.resolveRuntimeSpecifier(
      node.module,
      moduleManifest,
      diagnostics,
      "component",
    );
    if (!resolvedComponentSpecifier) {
      return createElementNode(
        "div",
        { "data-renderify-component-error": node.module },
        [createTextNode("Missing module manifest entry for component")],
      );
    }

    if (!this.moduleLoader) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_COMPONENT_SKIPPED",
        message: `Component ${resolvedComponentSpecifier} skipped because module loader is missing`,
      });
      return createElementNode(
        "div",
        { "data-renderify-missing-module": node.module },
        resolvedChildren,
      );
    }

    try {
      const loaded = await this.withRemainingBudget(
        () => this.moduleLoader!.load(resolvedComponentSpecifier),
        frame,
        `Component module timed out: ${resolvedComponentSpecifier}`,
      );

      const exportName = node.exportName ?? "default";
      const target = this.selectExport(loaded, exportName);

      if (typeof target !== "function") {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_COMPONENT_INVALID",
          message: `Export ${exportName} from ${resolvedComponentSpecifier} is not callable`,
        });
        return createElementNode(
          "div",
          { "data-renderify-component-error": `${node.module}:${exportName}` },
          [createTextNode("Component export is not callable")],
        );
      }

      const runtimeContext: RuntimeExecutionContext = {
        ...context,
        variables: {
          ...(context.variables ?? {}),
          state,
          event: event ? asJsonValue(event) : null,
        },
      };

      const produced = await this.executeComponentFactory(
        target as RuntimeComponentFactory,
        this.resolveProps(node.props, context, state, event) ?? {},
        runtimeContext,
        resolvedChildren,
        frame,
        `Component execution timed out: ${node.module}`,
        diagnostics,
      );

      if (typeof produced === "string") {
        return createTextNode(
          this.interpolateTemplate(produced, context, state, event),
        );
      }

      if (isRuntimeNode(produced)) {
        return this.resolveNode(
          produced,
          moduleManifest,
          context,
          state,
          event,
          diagnostics,
          frame,
        );
      }

      diagnostics.push({
        level: "error",
        code: "RUNTIME_COMPONENT_OUTPUT_INVALID",
        message: `Component ${resolvedComponentSpecifier} produced unsupported output`,
      });
      return createElementNode(
        "div",
        { "data-renderify-component-error": node.module },
        [createTextNode("Unsupported component output")],
      );
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_COMPONENT_EXEC_FAILED",
        message: `${resolvedComponentSpecifier}: ${this.errorToMessage(error)}`,
      });
      return createElementNode(
        "div",
        { "data-renderify-component-error": node.module },
        [createTextNode("Component execution failed")],
      );
    }
  }

  private async executeComponentFactory(
    componentFactory: RuntimeComponentFactory,
    props: Record<string, JsonValue>,
    context: RuntimeExecutionContext,
    children: RuntimeNode[],
    frame: ExecutionFrame,
    timeoutMessage: string,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<RuntimeNode | string> {
    if (frame.executionProfile !== "isolated-vm") {
      return this.withRemainingBudget(
        async () => componentFactory(props, context, children),
        frame,
        timeoutMessage,
      );
    }

    const isolated = await this.executeComponentInVm(
      componentFactory,
      props,
      context,
      children,
      frame,
    );

    if (isolated.mode === "isolation-unavailable") {
      if (!this.allowIsolationFallback) {
        throw new Error(
          "isolated-vm profile requested but node:vm is unavailable; fallback is disabled",
        );
      }

      diagnostics.push({
        level: "warning",
        code: "RUNTIME_SANDBOX_UNAVAILABLE",
        message:
          "isolated-vm profile requested but node:vm is unavailable; falling back to standard execution",
      });
      return this.withRemainingBudget(
        async () => componentFactory(props, context, children),
        frame,
        timeoutMessage,
      );
    }

    return isolated.value;
  }

  private async executeComponentInVm(
    componentFactory: RuntimeComponentFactory,
    props: Record<string, JsonValue>,
    context: RuntimeExecutionContext,
    children: RuntimeNode[],
    frame: ExecutionFrame,
  ): Promise<
    | { mode: "isolated"; value: RuntimeNode | string }
    | { mode: "isolation-unavailable" }
  > {
    const vmModule = await this.loadVmModule();
    if (!vmModule) {
      return { mode: "isolation-unavailable" };
    }

    const remainingMs = frame.maxExecutionMs - (nowMs() - frame.startedAt);
    if (remainingMs <= 0) {
      throw new Error("Component execution timed out before sandbox start");
    }

    const serializedFactory = componentFactory.toString();
    const sandboxData = {
      props: cloneJsonValue(props),
      context: cloneJsonValue(asJsonValue(context)),
      children: cloneJsonValue(asJsonValue(children)),
    };

    const script = new vmModule.Script(
      `'use strict';\n` +
        `const __component = (${serializedFactory});\n` +
        `const __result = __component(__input.props, __input.context, __input.children);\n` +
        `if (__result && typeof __result.then === "function") {\n` +
        `  throw new Error("Async component is not supported in isolated-vm profile");\n` +
        `}\n` +
        `__result;`,
    );

    const output = script.runInNewContext(
      {
        __input: sandboxData,
      },
      {
        timeout: Math.max(1, Math.floor(remainingMs)),
      },
    );

    if (typeof output === "string") {
      return {
        mode: "isolated",
        value: output,
      };
    }

    if (isRuntimeNode(output)) {
      return {
        mode: "isolated",
        value: output,
      };
    }

    throw new Error("Sandboxed component returned unsupported output");
  }

  private async resolveChildren(
    nodes: RuntimeNode[],
    moduleManifest: RuntimeModuleManifest | undefined,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
    diagnostics: RuntimeDiagnostic[],
    frame: ExecutionFrame,
  ): Promise<RuntimeNode[]> {
    const resolved: RuntimeNode[] = [];

    for (const child of nodes) {
      resolved.push(
        await this.resolveNode(
          child,
          moduleManifest,
          context,
          state,
          event,
          diagnostics,
          frame,
        ),
      );
    }

    return resolved;
  }

  private resolveProps(
    props: Record<string, JsonValue> | undefined,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
  ): Record<string, JsonValue> | undefined {
    if (!props) {
      return undefined;
    }

    const resolved: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(props)) {
      resolved[key] = this.resolveJsonValue(value, context, state, event);
    }

    return resolved;
  }

  private resolveJsonValue(
    value: JsonValue,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
  ): JsonValue {
    if (typeof value === "string") {
      return this.interpolateTemplate(value, context, state, event);
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.resolveJsonValue(item, context, state, event),
      );
    }

    if (value !== null && typeof value === "object") {
      const resolved: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        resolved[key] = this.resolveJsonValue(item, context, state, event);
      }
      return resolved;
    }

    return value;
  }

  private interpolateTemplate(
    template: string,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
  ): string {
    return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, expression) => {
      const resolved = this.resolveExpression(
        expression,
        context,
        state,
        event,
      );
      if (resolved === undefined || resolved === null) {
        return "";
      }

      if (typeof resolved === "object") {
        return JSON.stringify(resolved);
      }

      return String(resolved);
    });
  }

  private resolveExpression(
    expression: string,
    context: RuntimeExecutionContext,
    state: RuntimeStateSnapshot,
    event: RuntimeEvent | undefined,
  ): unknown {
    const path = expression.trim();

    if (path.startsWith("state.")) {
      return getValueByPath(state, path.slice(6));
    }

    if (path.startsWith("event.")) {
      return getValueByPath(event, path.slice(6));
    }

    if (path.startsWith("context.")) {
      return getValueByPath(context, path.slice(8));
    }

    if (path.startsWith("vars.")) {
      return getValueByPath(context.variables, path.slice(5));
    }

    return getValueByPath(state, path);
  }

  private selectExport(moduleNamespace: unknown, exportName: string): unknown {
    if (typeof moduleNamespace !== "object" || moduleNamespace === null) {
      return undefined;
    }

    const record = moduleNamespace as Record<string, unknown>;
    return record[exportName];
  }

  private isPreactLikeVNode(value: unknown): boolean {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return "type" in record && "props" in record;
  }

  private async loadPreactModule(): Promise<PreactLikeModule | undefined> {
    try {
      const maybePreact = (await import(getPreactSpecifier())) as unknown;
      if (!hasPreactFactory(maybePreact)) {
        return undefined;
      }

      return maybePreact;
    } catch {
      return undefined;
    }
  }

  private async loadVmModule(): Promise<NodeVmModule | undefined> {
    if (
      typeof process === "undefined" ||
      typeof process.versions !== "object" ||
      process.versions === null ||
      typeof process.versions.node !== "string"
    ) {
      return undefined;
    }

    try {
      const maybeVm = (await import(getVmSpecifier())) as unknown;
      if (!hasVmScript(maybeVm)) {
        return undefined;
      }

      return maybeVm;
    } catch {
      return undefined;
    }
  }

  private normalizeSupportedSpecVersions(versions?: string[]): Set<string> {
    const normalized = new Set<string>();
    const input =
      versions && versions.length > 0
        ? versions
        : FALLBACK_SUPPORTED_SPEC_VERSIONS;

    for (const entry of input) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }

    if (normalized.size === 0) {
      normalized.add(DEFAULT_RUNTIME_PLAN_SPEC_VERSION);
    }

    return normalized;
  }

  private normalizeFallbackCdnBases(input?: string[]): string[] {
    const candidates = input ?? FALLBACK_REMOTE_FALLBACK_CDN_BASES;
    const normalized = new Set<string>();

    for (const entry of candidates) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim().replace(/\/$/, "");
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }

    if (normalized.size === 0) {
      normalized.add(FALLBACK_ESM_CDN_BASE);
    }

    return [...normalized];
  }

  private normalizePositiveInteger(value: unknown, fallback: number): number {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      return fallback;
    }

    return value;
  }

  private normalizeNonNegativeInteger(
    value: unknown,
    fallback: number,
  ): number {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      return fallback;
    }

    return value;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("RuntimeManager is not initialized");
    }
  }

  private hasExceededBudget(frame: ExecutionFrame): boolean {
    return nowMs() - frame.startedAt > frame.maxExecutionMs;
  }

  private async withRemainingBudget<T>(
    operation: () => Promise<T>,
    frame: ExecutionFrame,
    timeoutMessage: string,
  ): Promise<T> {
    const remainingMs = frame.maxExecutionMs - (nowMs() - frame.startedAt);
    if (remainingMs <= 0) {
      throw new Error(timeoutMessage);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, remainingMs);
    });

    try {
      return await Promise.race([operation(), timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

interface NodeVmScript {
  runInNewContext(
    contextObject: Record<string, unknown>,
    options: { timeout?: number },
  ): unknown;
}

interface NodeVmModule {
  Script: new (code: string) => NodeVmScript;
}

interface PreactLikeModule {
  h(type: unknown, props: unknown, ...children: unknown[]): unknown;
}

function hasVmScript(value: unknown): value is NodeVmModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { Script?: unknown };
  return typeof candidate.Script === "function";
}

function hasPreactFactory(value: unknown): value is PreactLikeModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { h?: unknown };
  return typeof candidate.h === "function";
}

function getVmSpecifier(): string {
  return "node:vm";
}

function getPreactSpecifier(): string {
  return "preact";
}

export type { JspmModuleLoaderOptions } from "./jspm-module-loader";
export { JspmModuleLoader } from "./jspm-module-loader";
