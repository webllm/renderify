# Runtime Contracts

## RuntimePlan

`RuntimePlan` is the canonical execution unit.

```ts
interface RuntimePlan {
  specVersion?: string; // default: "runtime-plan/v1"
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

`moduleManifest` contract (optional, but recommended/required by strict policy):

```ts
interface RuntimeModuleManifest {
  [specifier: string]: {
    resolvedUrl: string;
    integrity?: string;
    version?: string;
    signer?: string;
  };
}
```

`source` contract (optional):

```ts
interface RuntimeSourceModule {
  code: string;
  language: "js" | "jsx" | "ts" | "tsx";
  exportName?: string; // default: "default"
}
```

## RuntimeNode

`RuntimeNode` supports:

- `text`
- `element`
- `component`

`component` nodes are resolved by runtime through a module loader.

## State Model

```ts
interface RuntimeStateModel {
  initial: RuntimeStateSnapshot;
  transitions?: Record<string, RuntimeAction[]>;
}

type RuntimeAction =
  | { type: "set"; path: string; value: JsonValue | { $from: string } }
  | { type: "increment"; path: string; by?: number }
  | { type: "toggle"; path: string }
  | { type: "push"; path: string; value: JsonValue | { $from: string } };
```

Supported `$from` sources:

- `state.*`
- `event.*`
- `context.*`
- `vars.*`

## Runtime Capabilities

```ts
interface RuntimeCapabilities {
  domWrite?: boolean;
  networkHosts?: string[];
  allowedModules?: string[];
  timers?: boolean;
  storage?: Array<"localStorage" | "sessionStorage">;
  executionProfile?: "standard" | "isolated-vm";
  maxImports?: number;
  maxComponentInvocations?: number;
  maxExecutionMs?: number;
}
```

## RuntimeExecutionResult

```ts
interface RuntimeExecutionResult {
  planId: string;
  root: RuntimeNode;
  diagnostics: RuntimeDiagnostic[];
  state?: RuntimeStateSnapshot;
  handledEvent?: RuntimeEvent;
  appliedActions?: RuntimeAction[];
}
```

Diagnostics include policy/runtime results such as:

- skipped imports
- import failures
- component failures
- timeout/quotas exceeded
- unhandled events and action failures

## LLM Structured Contract

Prompt execution prefers `runtime-plan` structured output when LLM adapter supports it.

Fallback behavior:

1. try structured output (`valid=true` required)
2. if invalid, fallback to text generation and codegen parsing

Current provider adapters:

- `@renderify/core` (mock/default)
- `@renderify/llm-openai` (real provider)

## LLM Text TSX Contract

When structured mode is disabled, text output can contain fenced source blocks:

- ```` ```tsx ... ``` ````
- ```` ```jsx ... ``` ````
- ```` ```ts ... ``` ````
- ```` ```js ... ``` `````

`@renderify/core` converts these into `RuntimePlan.source`, and runtime executes
them via Babel transpilation + JSPM-style import resolution.

## Security Policy Contract

`@renderify/core` validates plan and capabilities before execution.

Policy dimensions:

- blocked tags
- max depth / max node count
- module allowlist
- network host allowlist
- inline handler policy
- transition/action limits
- requested quota upper bounds
- specVersion compatibility checks
- moduleManifest coverage/integrity checks
- runtime source static checks (blocked patterns, dynamic import policy, source import count)

A rejected plan must never reach runtime execution.

Security profiles:

- `strict`
- `balanced` (default)
- `relaxed`

## Module Loader Contract

`@renderify/runtime` depends on:

```ts
interface RuntimeModuleLoader {
  load(specifier: string): Promise<unknown>;
  unload?(specifier: string): Promise<void>;
}
```

`@renderify/runtime` implements JSPM/SystemJS resolution and loading.
