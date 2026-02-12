import {
  asJsonValue,
  cloneJsonValue,
  isRuntimeNode,
  type JsonValue,
  type RuntimeDiagnostic,
  type RuntimeExecutionContext,
  type RuntimeExecutionProfile,
  type RuntimeNode,
  type RuntimeRenderArtifact,
} from "@renderify/ir";
import {
  getPreactSpecifier,
  getVmSpecifier,
  hasPreactFactory,
  hasVmScript,
  type NodeVmModule,
  nowMs,
} from "./runtime-environment";

type PreactLikeModule = {
  h(type: unknown, props: unknown, ...children: unknown[]): unknown;
};

export type RuntimeComponentFactory = (
  props: Record<string, JsonValue>,
  context: RuntimeExecutionContext,
  children: RuntimeNode[],
) => Promise<RuntimeNode | string> | RuntimeNode | string;

export async function createPreactRenderArtifact(input: {
  sourceExport: unknown;
  runtimeInput: Record<string, JsonValue>;
  diagnostics: RuntimeDiagnostic[];
}): Promise<RuntimeRenderArtifact | undefined> {
  const preact = await loadPreactModule();
  if (!preact) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_UNAVAILABLE",
      message:
        "source.runtime=preact requested but preact runtime is unavailable",
    });
    return undefined;
  }

  if (isPreactLikeVNode(input.sourceExport)) {
    return {
      mode: "preact-vnode",
      payload: input.sourceExport,
    };
  }

  if (typeof input.sourceExport !== "function") {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_EXPORT_INVALID",
      message: "source.runtime=preact requires a component export function",
    });
    return undefined;
  }

  try {
    const vnode = preact.h(
      input.sourceExport as (props: Record<string, JsonValue>) => unknown,
      input.runtimeInput,
    );

    return {
      mode: "preact-vnode",
      payload: vnode,
    };
  } catch (error) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_VNODE_FAILED",
      message: errorToMessage(error),
    });
    return undefined;
  }
}

export async function executeComponentFactory(input: {
  componentFactory: RuntimeComponentFactory;
  props: Record<string, JsonValue>;
  context: RuntimeExecutionContext;
  children: RuntimeNode[];
  executionProfile: RuntimeExecutionProfile;
  maxExecutionMs: number;
  startedAt: number;
  timeoutMessage: string;
  allowIsolationFallback: boolean;
  diagnostics: RuntimeDiagnostic[];
  withRemainingBudget<T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
}): Promise<RuntimeNode | string> {
  if (input.executionProfile !== "isolated-vm") {
    return input.withRemainingBudget(
      async () =>
        input.componentFactory(input.props, input.context, input.children),
      input.timeoutMessage,
    );
  }

  const isolated = await executeComponentInVm(input);

  if (isolated.mode === "isolation-unavailable") {
    if (!input.allowIsolationFallback) {
      throw new Error(
        "isolated-vm profile requested but node:vm is unavailable; fallback is disabled",
      );
    }

    input.diagnostics.push({
      level: "warning",
      code: "RUNTIME_SANDBOX_UNAVAILABLE",
      message:
        "isolated-vm profile requested but node:vm is unavailable; falling back to standard execution",
    });
    return input.withRemainingBudget(
      async () =>
        input.componentFactory(input.props, input.context, input.children),
      input.timeoutMessage,
    );
  }

  return isolated.value;
}

async function executeComponentInVm(input: {
  componentFactory: RuntimeComponentFactory;
  props: Record<string, JsonValue>;
  context: RuntimeExecutionContext;
  children: RuntimeNode[];
  maxExecutionMs: number;
  startedAt: number;
}): Promise<
  | { mode: "isolated"; value: RuntimeNode | string }
  | { mode: "isolation-unavailable" }
> {
  const vmModule = await loadVmModule();
  if (!vmModule) {
    return { mode: "isolation-unavailable" };
  }

  const remainingMs = input.maxExecutionMs - (nowMs() - input.startedAt);
  if (remainingMs <= 0) {
    throw new Error("Component execution timed out before sandbox start");
  }

  const serializedFactory = input.componentFactory.toString();
  const sandboxData = {
    props: cloneJsonValue(input.props),
    context: cloneJsonValue(asJsonValue(input.context)),
    children: cloneJsonValue(asJsonValue(input.children)),
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

function isPreactLikeVNode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return "type" in record && "props" in record;
}

async function loadPreactModule(): Promise<PreactLikeModule | undefined> {
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

async function loadVmModule(): Promise<NodeVmModule | undefined> {
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

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
