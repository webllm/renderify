import {
  asJsonValue,
  cloneJsonValue,
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
  type RuntimeSourceLanguage,
  type RuntimeSourceModule,
  type RuntimeStateSnapshot,
  resolveRuntimePlanSpecVersion,
  setValueByPath,
} from "@renderify/ir";

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

export interface RuntimeManager {
  initialize(): Promise<void>;
  terminate(): Promise<void>;
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
}

export interface RuntimeSourceTranspileInput {
  code: string;
  language: RuntimeSourceLanguage;
  filename?: string;
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
const FALLBACK_SUPPORTED_SPEC_VERSIONS = [DEFAULT_RUNTIME_PLAN_SPEC_VERSION];
const FALLBACK_ENFORCE_MODULE_MANIFEST = true;
const FALLBACK_ALLOW_ISOLATION_FALLBACK = false;

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
      presets.push([
        "react",
        {
          runtime: "classic",
          pragma: "__renderify_runtime_h",
          pragmaFrag: "__renderify_runtime_fragment",
        },
      ]);
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
  }

  async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
    return this.executePlan(
      input.plan,
      input.context,
      input.event,
      input.stateOverride,
    );
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
    const appliedActions = this.applyEvent(
      plan,
      event,
      state,
      context,
      diagnostics,
    );

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

    const resolvedRoot = sourceRoot
      ? await this.resolveNode(
          sourceRoot,
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

    this.states.set(plan.id, cloneJsonValue(state));

    return {
      planId: plan.id,
      root: resolvedRoot,
      diagnostics,
      state: cloneJsonValue(state),
      handledEvent: event,
      appliedActions,
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
      const cloned = cloneJsonValue(stateOverride);
      this.states.set(plan.id, cloneJsonValue(cloned));
      return cloned;
    }

    const existing = this.states.get(plan.id);
    if (existing) {
      return cloneJsonValue(existing);
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
  ): Promise<RuntimeNode | undefined> {
    try {
      const transpiled = await this.withRemainingBudget(
        () => this.transpileRuntimeSource(source),
        frame,
        "Runtime source transpilation timed out",
      );
      const rewritten = this.rewriteSourceImports(
        transpiled,
        plan.moduleManifest,
        diagnostics,
      );
      const namespace = await this.withRemainingBudget(
        () => this.importSourceModuleFromCode(rewritten),
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

      return normalized;
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
    const mergedSource = `${source.code}\n\n${RUNTIME_JSX_HELPERS}`;
    return this.sourceTranspiler.transpile({
      code: mergedSource,
      language: source.language,
      filename: `renderify-runtime-source.${source.language}`,
    });
  }

  private rewriteSourceImports(
    code: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): string {
    return [
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ].reduce((current, pattern) => {
      return current.replace(pattern, (full, specifier: string) => {
        const rewritten = this.resolveRuntimeSourceSpecifier(
          specifier,
          moduleManifest,
          diagnostics,
        );
        return full.replace(specifier, rewritten);
      });
    }, code);
  }

  private resolveRuntimeSourceSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): string {
    const trimmed = specifier.trim();
    if (!this.shouldRewriteSpecifier(trimmed)) {
      return trimmed;
    }

    const fromManifest = this.resolveRuntimeSpecifier(
      trimmed,
      moduleManifest,
      diagnostics,
      "source-import",
    );
    if (!fromManifest) {
      return trimmed;
    }

    if (this.moduleLoader && this.hasResolveSpecifier(this.moduleLoader)) {
      try {
        return this.moduleLoader.resolveSpecifier(fromManifest);
      } catch {
        // fall through to default resolver
      }
    }

    if (fromManifest.startsWith("npm:")) {
      return `${FALLBACK_JSPM_CDN_BASE}/${fromManifest.slice(4)}`;
    }

    if (this.isDirectSpecifier(fromManifest)) {
      return fromManifest;
    }

    return `${FALLBACK_JSPM_CDN_BASE}/${fromManifest}`;
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

  private async importSourceModuleFromCode(code: string): Promise<unknown> {
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

    if (
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function" &&
      typeof Blob !== "undefined"
    ) {
      const blob = new Blob([code], {
        type: "text/javascript",
      });
      const moduleUrl = URL.createObjectURL(blob);

      try {
        return await import(/* webpackIgnore: true */ moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
    }

    if (typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      const dataUrl = `data:text/javascript;base64,${encoded}`;
      return import(/* webpackIgnore: true */ dataUrl);
    }

    throw new Error("No runtime module import strategy is available");
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

function hasVmScript(value: unknown): value is NodeVmModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { Script?: unknown };
  return typeof candidate.Script === "function";
}

function getVmSpecifier(): string {
  return "node:vm";
}
