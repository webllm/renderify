# API Reference

Complete type and function reference for all Renderify packages.

## @renderify/ir

The intermediate representation package. Defines all core types and utilities.

### Types

#### RuntimePlan

```ts
interface RuntimePlan {
  specVersion?: string;
  id: string;
  version: number;
  root: RuntimeNode;
  capabilities: RuntimeCapabilities;
  state?: RuntimeStateModel;
  imports?: string[];
  moduleManifest?: RuntimeModuleManifest;
  source?: RuntimeSourceModule;
  metadata?: RuntimePlanMetadata;
}
```

#### RuntimeNode

```ts
type RuntimeNode = RuntimeTextNode | RuntimeElementNode | RuntimeComponentNode;

interface RuntimeTextNode {
  type: "text";
  value: string;
}

interface RuntimeElementNode {
  type: "element";
  tag: string;
  props?: Record<string, JsonValue>;
  children?: RuntimeNode[];
}

interface RuntimeComponentNode {
  type: "component";
  module: string;
  exportName?: string;
  props?: Record<string, JsonValue>;
  children?: RuntimeNode[];
}
```

#### RuntimeCapabilities

```ts
interface RuntimeCapabilities {
  domWrite?: boolean;
  networkHosts?: string[];
  allowedModules?: string[];
  timers?: boolean;
  storage?: Array<"localStorage" | "sessionStorage">;
  executionProfile?: RuntimeExecutionProfile;
  maxImports?: number;
  maxComponentInvocations?: number;
  maxExecutionMs?: number;
}

type RuntimeExecutionProfile = "standard" | "isolated-vm" | "sandbox-worker" | "sandbox-iframe";
```

#### RuntimeStateModel

```ts
interface RuntimeStateModel {
  initial: RuntimeStateSnapshot;
  transitions?: Record<string, RuntimeAction[]>;
}

type RuntimeStateSnapshot = Record<string, JsonValue>;
```

#### RuntimeAction

```ts
type RuntimeAction =
  | RuntimeSetAction
  | RuntimeIncrementAction
  | RuntimeToggleAction
  | RuntimePushAction;

interface RuntimeSetAction {
  type: "set";
  path: string;
  value: JsonValue | RuntimeValueFromPath;
}

interface RuntimeIncrementAction {
  type: "increment";
  path: string;
  by?: number;
}

interface RuntimeToggleAction {
  type: "toggle";
  path: string;
}

interface RuntimePushAction {
  type: "push";
  path: string;
  value: JsonValue | RuntimeValueFromPath;
}

interface RuntimeValueFromPath {
  $from: string;
}
```

#### RuntimeModuleManifest

```ts
type RuntimeModuleManifest = Record<string, RuntimeModuleDescriptor>;

interface RuntimeModuleDescriptor {
  resolvedUrl: string;
  integrity?: string;
  version?: string;
  signer?: string;
}
```

#### RuntimeSourceModule

```ts
interface RuntimeSourceModule {
  code: string;
  language: RuntimeSourceLanguage;
  exportName?: string;
  runtime?: RuntimeSourceRuntime;
}

type RuntimeSourceLanguage = "js" | "jsx" | "ts" | "tsx";
type RuntimeSourceRuntime = "renderify" | "preact";
```

#### RuntimeExecutionResult

```ts
interface RuntimeExecutionResult {
  planId: string;
  root: RuntimeNode;
  diagnostics: RuntimeDiagnostic[];
  state?: RuntimeStateSnapshot;
  handledEvent?: RuntimeEvent;
  appliedActions?: RuntimeAction[];
  renderArtifact?: RuntimeRenderArtifact;
}

interface RuntimeDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

interface RuntimeRenderArtifact {
  mode: "preact-vnode";
  payload: unknown;
}
```

#### RuntimePlanMetadata

```ts
interface RuntimePlanMetadata {
  sourcePrompt?: string;
  sourceModel?: string;
  tags?: string[];
  [key: string]: JsonValue | undefined;
}
```

### Functions

#### Node Creation

```ts
function createTextNode(value: string): RuntimeTextNode;
function createElementNode(tag: string, props?: Record<string, JsonValue>, children?: RuntimeNode[]): RuntimeElementNode;
function createComponentNode(module: string, exportName?: string, props?: Record<string, JsonValue>, children?: RuntimeNode[]): RuntimeComponentNode;
```

#### Validation Guards

```ts
function isRuntimePlan(value: unknown): value is RuntimePlan;
function isRuntimeNode(value: unknown): value is RuntimeNode;
function isRuntimeAction(value: unknown): value is RuntimeAction;
function isRuntimeStateModel(value: unknown): value is RuntimeStateModel;
function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities;
function isRuntimeSourceModule(value: unknown): value is RuntimeSourceModule;
function isRuntimeModuleManifest(value: unknown): value is RuntimeModuleManifest;
function isRuntimeModuleDescriptor(value: unknown): value is RuntimeModuleDescriptor;
function isRuntimeEvent(value: unknown): value is RuntimeEvent;
function isRuntimePlanMetadata(value: unknown): value is RuntimePlanMetadata;
function isRuntimeSourceLanguage(value: unknown): value is RuntimeSourceLanguage;
function isRuntimeSourceRuntime(value: unknown): value is RuntimeSourceRuntime;
function isRuntimeValueFromPath(value: unknown): value is RuntimeValueFromPath;
function isRuntimeStateSnapshot(value: unknown): value is RuntimeStateSnapshot;
function isJsonValue(value: unknown): value is JsonValue;
```

#### Tree Utilities

```ts
function walkRuntimeNode(node: RuntimeNode, visitor: (node: RuntimeNode, depth: number) => void, depth?: number): void;
function collectComponentModules(root: RuntimeNode): string[];
```

#### Path Utilities

```ts
function splitPath(path: string): string[];
function isSafePath(path: string): boolean;
function getValueByPath(source: unknown, path: string): unknown;
function setValueByPath(target: RuntimeStateSnapshot, path: string, value: JsonValue): void;
```

#### JSON Utilities

```ts
function cloneJsonValue<T extends JsonValue>(value: T): T;
function asJsonValue(value: unknown): JsonValue;
```

#### Hash Utilities

```ts
function createFnv1a64Hasher(): Fnv1a64Hasher;
function hashStringFNV1a32(input: string): number;
function hashStringFNV1a32Base36(input: string): string;
function hashStringFNV1a64Hex(input: string): string;
```

#### Source Import Parsing

```ts
function collectRuntimeSourceImports(code: string): Promise<string[]>;
function parseRuntimeSourceImportRanges(code: string): Promise<RuntimeSourceImportRange[]>;

interface RuntimeSourceImportRange {
  start: number;
  end: number;
  specifier: string;
}
```

---

## @renderify/runtime

### renderPlanInBrowser

```ts
function renderPlanInBrowser(
  plan: RuntimePlan,
  options?: RuntimeEmbedRenderOptions,
): Promise<RuntimeEmbedRenderResult>;

interface RuntimeEmbedRenderOptions {
  target?: string | HTMLElement | InteractiveRenderTarget;
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

interface RuntimeEmbedRenderResult {
  html: string;
  execution: RuntimeExecutionResult;
  security: SecurityCheckResult;
  runtime: RuntimeManager;
}
```

### DefaultRuntimeManager

```ts
class DefaultRuntimeManager implements RuntimeManager {
  constructor(options?: Partial<RuntimeManagerOptions>);
  initialize(): Promise<void>;
  terminate(): Promise<void>;
  execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult>;
  executePlan(
    plan: RuntimePlan,
    context?: RuntimeExecutionContext,
    event?: RuntimeEvent,
    stateOverride?: RuntimeStateSnapshot,
    signal?: AbortSignal,
  ): Promise<RuntimeExecutionResult>;
  compile(plan: RuntimePlan, options?: CompileOptions): Promise<string>;
  probePlan(plan: RuntimePlan): Promise<RuntimePlanProbeResult>;
  getPlanState(planId: string): RuntimeStateSnapshot | undefined;
  setPlanState(planId: string, state: RuntimeStateSnapshot): void;
  clearPlanState(planId: string): void;
}

interface RuntimeManagerOptions {
  moduleLoader?: RuntimeModuleLoader;
  sourceTranspiler?: RuntimeSourceTranspiler;
  defaultMaxImports?: number;
  defaultMaxComponentInvocations?: number;
  defaultMaxExecutionMs?: number;
  defaultExecutionProfile?: RuntimeExecutionProfile;
  supportedPlanSpecVersions?: string[];
  enforceModuleManifest?: boolean;
  allowIsolationFallback?: boolean;
  browserSourceSandboxMode?: "none" | "worker" | "iframe";
  browserSourceSandboxTimeoutMs?: number;
  browserSourceSandboxFailClosed?: boolean;
  enableDependencyPreflight?: boolean;
  failOnDependencyPreflightError?: boolean;
  remoteFetchTimeoutMs?: number;
  remoteFetchRetries?: number;
  remoteFetchBackoffMs?: number;
  remoteFallbackCdnBases?: string[];
}

interface RuntimeExecutionInput {
  plan: RuntimePlan;
  context?: RuntimeExecutionContext;
  event?: RuntimeEvent;
  stateOverride?: RuntimeStateSnapshot;
  signal?: AbortSignal;
}

interface CompileOptions {
  pretty?: boolean;
}
```

### JspmModuleLoader

```ts
class JspmModuleLoader implements RuntimeModuleLoader {
  constructor(options?: JspmModuleLoaderOptions);
  load(specifier: string): Promise<unknown>;
  resolveSpecifier(specifier: string): string;
}

interface JspmModuleLoaderOptions {
  cdnBaseUrl?: string;
  importMap?: Record<string, string>;
}
```

### DefaultUIRenderer

```ts
class DefaultUIRenderer implements UIRenderer {
  render(result: RuntimeExecutionResult, target?: RenderTarget): Promise<string>;
  renderNode(node: RuntimeNode): string;
}
```

### BabelRuntimeSourceTranspiler

```ts
class BabelRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  transpile(input: RuntimeSourceTranspileInput): Promise<string>;
  static mergeRuntimeHelpers(
    source: RuntimeSourceTranspileInput["code"],
    runtime: RuntimeSourceTranspileInput["runtime"],
  ): string;
}

interface RuntimeSourceTranspileInput {
  code: string;
  language: RuntimeSourceLanguage;
  filename?: string;
  runtime?: RuntimeSourceModule["runtime"];
}
```

---

## @renderify/security

### DefaultSecurityChecker

```ts
class DefaultSecurityChecker implements SecurityChecker {
  initialize(input?: SecurityInitializationInput): void;
  getPolicy(): RuntimeSecurityPolicy;
  getProfile(): RuntimeSecurityProfile;
  checkPlan(plan: RuntimePlan): Promise<SecurityCheckResult>;
  checkModuleSpecifier(specifier: string): SecurityCheckResult;
  checkCapabilities(capabilities: RuntimeCapabilities, moduleManifest?: RuntimeModuleManifest): SecurityCheckResult;
}

type SecurityInitializationInput =
  | Partial<RuntimeSecurityPolicy>
  | SecurityInitializationOptions
  | undefined;

interface SecurityInitializationOptions {
  profile?: RuntimeSecurityProfile;
  overrides?: Partial<RuntimeSecurityPolicy>;
}

interface SecurityCheckResult {
  safe: boolean;
  issues: string[];
  diagnostics: RuntimeDiagnostic[];
}

type RuntimeSecurityProfile = "strict" | "balanced" | "relaxed";
```

### Utility Functions

```ts
function listSecurityProfiles(): RuntimeSecurityProfile[];
function getSecurityProfilePolicy(profile: RuntimeSecurityProfile): RuntimeSecurityPolicy;
```

---

## @renderify/core

### RenderifyApp

```ts
class RenderifyApp {
  constructor(deps: RenderifyCoreDependencies);
  start(): Promise<void>;
  stop(): Promise<void>;
  renderPrompt(prompt: string, options?: RenderPromptOptions): Promise<RenderPromptResult>;
  renderPromptStream(prompt: string, options?: RenderPromptStreamOptions): AsyncGenerator<RenderPromptStreamChunk, RenderPromptResult>;
  renderPlan(plan: RuntimePlan, options?: RenderPlanOptions): Promise<RenderPlanResult>;
  getConfig(): RenderifyConfig;
  getContext(): ContextManager;
  getLLM(): LLMInterpreter;
  getCodeGenerator(): CodeGenerator;
  getRuntimeManager(): RuntimeManager;
  getSecurityChecker(): SecurityChecker;
  on(eventName: string, callback: (...args: unknown[]) => void): () => void;
  emit(eventName: string, payload?: unknown): void;
}

function createRenderifyApp(deps: RenderifyCoreDependencies): RenderifyApp;
```

### Core Dependencies

```ts
interface RenderifyCoreDependencies {
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
```

### Render Result Types

```ts
interface RenderPlanResult {
  traceId: string;
  plan: RuntimePlan;
  security: SecurityCheckResult;
  execution: RuntimeExecutionResult;
  html: string;
}

interface RenderPromptResult extends RenderPlanResult {
  prompt: string;
  llm: LLMResponse;
}

interface RenderPromptStreamChunk {
  type: "llm-delta" | "preview" | "final" | "error";
  traceId: string;
  prompt: string;
  llmText: string;
  delta?: string;
  html?: string;
  diagnostics?: RuntimeDiagnostic[];
  planId?: string;
  final?: RenderPromptResult;
  error?: { message: string; name?: string };
}
```

### DefaultCodeGenerator

```ts
class DefaultCodeGenerator implements CodeGenerator {
  generatePlan(input: CodeGenerationInput): Promise<RuntimePlan>;
  createIncrementalSession(init: { prompt: string; context: Record<string, unknown> }): IncrementalCodeGenerationSession;
  validatePlan(plan: RuntimePlan): Promise<boolean>;
  transformPlan(plan: RuntimePlan, transforms: Array<(plan: RuntimePlan) => RuntimePlan>): Promise<RuntimePlan>;
}
```

### DefaultRenderifyConfig

```ts
class DefaultRenderifyConfig implements RenderifyConfig {
  load(overrides?: Partial<RenderifyConfigValues>): Promise<void>;
  snapshot(): Readonly<Record<string, unknown>>;
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  save(): Promise<void>;
}
```

### DefaultContextManager

```ts
class DefaultContextManager implements ContextManager {
  initialize(): Promise<void>;
  getContext(): RenderifyContext;
  updateContext(partial: Partial<RenderifyContext>): void;
  subscribe(listener: (ctx: RenderifyContext) => void): () => void;
}
```

### DefaultCustomizationEngine

```ts
class DefaultCustomizationEngine implements CustomizationEngine {
  registerPlugin(plugin: RenderifyPlugin): void;
  getPlugins(): RenderifyPlugin[];
  runHook<Payload>(hookName: PluginHook, payload: Payload, context: PluginContext): Promise<Payload>;
}
```

### PolicyRejectionError

```ts
class PolicyRejectionError extends Error {
  readonly result: SecurityCheckResult;
  constructor(result: SecurityCheckResult);
}
```

---

## @renderify/llm

### createLLMInterpreter

```ts
function createLLMInterpreter(options: {
  provider?: string;
  providerOptions?: Record<string, unknown>;
  registry?: LLMProviderRegistry;
}): LLMInterpreter;
```

### Provider Classes

```ts
class OpenAILLMInterpreter implements LLMInterpreter { /* ... */ }
class AnthropicLLMInterpreter implements LLMInterpreter { /* ... */ }
class GoogleLLMInterpreter implements LLMInterpreter { /* ... */ }
```

### LLMProviderRegistry

```ts
class LLMProviderRegistry {
  register(definition: LLMProviderDefinition): this;
  unregister(name: string): boolean;
  has(name: string): boolean;
  list(): string[];
  resolve(name: string): LLMProviderDefinition | undefined;
  create(name: string, options?: Record<string, unknown>): LLMInterpreter;
}

function createDefaultLLMProviderRegistry(): LLMProviderRegistry;
```

### LLM Interfaces

```ts
interface LLMInterpreter {
  configure(options: Record<string, unknown>): void;
  generateResponse(request: LLMRequest): Promise<LLMResponse>;
  generateResponseStream?(request: LLMRequest): AsyncIterable<LLMResponseStreamChunk>;
  generateStructuredResponse?(request: LLMStructuredRequest): Promise<LLMStructuredResponse<unknown>>;
  setPromptTemplate(name: string, template: string): void;
  getPromptTemplate(name: string): string | undefined;
}

interface LLMRequest {
  prompt: string;
  context?: Record<string, unknown>;
  systemPrompt?: string;
  signal?: AbortSignal;
}

interface LLMResponse {
  text: string;
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

interface LLMResponseStreamChunk {
  delta: string;
  text: string;
  done: boolean;
  index: number;
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

interface LLMStructuredRequest extends LLMRequest {
  format: "runtime-plan";
  strict?: boolean;
}

interface LLMStructuredResponse<T> {
  value?: T;
  text: string;
  valid: boolean;
  errors?: string[];
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}
```
