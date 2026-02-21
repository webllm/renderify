import type {
  RuntimeDiagnostic,
  RuntimeEvent,
  RuntimeExecutionContext,
  RuntimeExecutionProfile,
  RuntimeExecutionResult,
  RuntimePlan,
  RuntimeSourceLanguage,
  RuntimeSourceModule,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import type {
  SecurityChecker,
  SecurityCheckResult,
  SecurityInitializationInput,
} from "@renderify/security";
import type {
  RuntimeDependencyProbeStatus,
  RuntimeDependencyUsage,
} from "./runtime-preflight";
import type {
  RuntimeSourceJsxHelperMode as RuntimeSourceRuntimeJsxHelperMode,
  RuntimeSourceSandboxMode as RuntimeSourceRuntimeMode,
} from "./runtime-source-runtime";
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

export type { RuntimeDependencyProbeStatus, RuntimeDependencyUsage };

export interface RuntimePlanProbeResult {
  planId: string;
  diagnostics: RuntimeDiagnostic[];
  dependencies: RuntimeDependencyProbeStatus[];
}

export interface RuntimeManager {
  configure?(options: RuntimeManagerOptions): void;
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
  runtimeSourceJsxHelperMode?: RuntimeSourceJsxHelperMode;
  browserSourceSandboxTimeoutMs?: number;
  browserSourceSandboxFailClosed?: boolean;
  enableDependencyPreflight?: boolean;
  failOnDependencyPreflightError?: boolean;
  remoteFetchTimeoutMs?: number;
  remoteFetchRetries?: number;
  remoteFetchBackoffMs?: number;
  remoteFallbackCdnBases?: string[];
  browserModuleUrlCacheMaxEntries?: number;
  runtimeSourceLocalSpecifierCacheMaxEntries?: number;
  allowArbitraryNetwork?: boolean;
  allowedNetworkHosts?: string[];
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
  autoPinLatestModuleManifest?: boolean;
  autoPinModuleLoader?: RuntimeModuleLoader;
  autoPinFetchTimeoutMs?: number;
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

export type RuntimeSourceSandboxMode = RuntimeSourceRuntimeMode;
export type RuntimeSourceJsxHelperMode = RuntimeSourceRuntimeJsxHelperMode;
