import type {
  JsonValue,
  RuntimeDiagnostic,
  RuntimeEvent,
  RuntimeExecutionContext,
  RuntimeExecutionProfile,
  RuntimeModuleManifest,
  RuntimeNode,
  RuntimePlan,
  RuntimeRenderArtifact,
  RuntimeSourceModule,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import { selectExportFromNamespace } from "./runtime-node-resolver";
import type { RuntimeSourceSandboxMode } from "./runtime-source-runtime";
import {
  executeSourceInBrowserSandbox,
  type RuntimeSandboxRequest,
} from "./sandbox";

export interface ResolvedSourceOutput {
  root?: RuntimeNode;
  renderArtifact?: RuntimeRenderArtifact;
}

export interface RuntimeSourceExecutionInput {
  plan: RuntimePlan;
  source: RuntimeSourceModule;
  context: RuntimeExecutionContext;
  state: RuntimeStateSnapshot;
  event: RuntimeEvent | undefined;
  diagnostics: RuntimeDiagnostic[];
  frame: {
    executionProfile: RuntimeExecutionProfile;
    signal?: AbortSignal;
  };
  browserSourceSandboxTimeoutMs: number;
  browserSourceSandboxFailClosed: boolean;
  withRemainingBudget: <T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ) => Promise<T>;
  transpileRuntimeSource: (source: RuntimeSourceModule) => Promise<string>;
  rewriteSourceImports: (
    code: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ) => Promise<string>;
  resolveSourceSandboxMode: (
    source: RuntimeSourceModule,
    executionProfile: RuntimeExecutionProfile,
  ) => RuntimeSourceSandboxMode;
  importSourceModuleFromCode: (
    code: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ) => Promise<unknown>;
  normalizeSourceOutput: (output: unknown) => RuntimeNode | undefined;
  shouldUsePreactSourceRuntime: (source: RuntimeSourceModule) => boolean;
  createPreactRenderArtifact: (input: {
    sourceExport: unknown;
    runtimeInput: Record<string, JsonValue>;
    diagnostics: RuntimeDiagnostic[];
  }) => Promise<RuntimeRenderArtifact | undefined>;
  isAbortError: (error: unknown) => boolean;
  errorToMessage: (error: unknown) => string;
  cloneJsonValue: <T extends JsonValue>(value: T) => T;
  asJsonValue: (value: unknown) => JsonValue;
}

export async function executeRuntimeSourceRoot(
  input: RuntimeSourceExecutionInput,
): Promise<ResolvedSourceOutput | undefined> {
  const {
    plan,
    source,
    context,
    state,
    event,
    diagnostics,
    frame,
    browserSourceSandboxTimeoutMs,
    browserSourceSandboxFailClosed,
  } = input;

  try {
    const exportName = source.exportName ?? "default";
    const runtimeInput = {
      context: input.cloneJsonValue(input.asJsonValue(context)),
      state: input.cloneJsonValue(state),
      event: event ? input.cloneJsonValue(input.asJsonValue(event)) : null,
    };
    const transpiled = await input.withRemainingBudget(
      () => input.transpileRuntimeSource(source),
      "Runtime source transpilation timed out",
    );
    const rewritten = await input.rewriteSourceImports(
      transpiled,
      plan.moduleManifest,
      diagnostics,
    );

    const sandboxMode = input.resolveSourceSandboxMode(
      source,
      frame.executionProfile,
    );
    if (sandboxMode !== "none") {
      try {
        const sandboxResult = await input.withRemainingBudget(
          () =>
            executeSourceInBrowserSandbox({
              mode: sandboxMode,
              timeoutMs: browserSourceSandboxTimeoutMs,
              signal: frame.signal,
              request: {
                renderifySandbox: "runtime-source",
                id: `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
                code: rewritten,
                exportName,
                runtimeInput,
              } satisfies RuntimeSandboxRequest,
            }),
          `Runtime source sandbox (${sandboxMode}) timed out`,
        );

        const normalized = input.normalizeSourceOutput(sandboxResult.output);
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
          message: `Runtime source executed in ${sandboxResult.mode} sandbox`,
        });

        return {
          root: normalized,
        };
      } catch (error) {
        if (input.isAbortError(error)) {
          throw error;
        }
        const message = input.errorToMessage(error);
        diagnostics.push({
          level: browserSourceSandboxFailClosed ? "error" : "warning",
          code: browserSourceSandboxFailClosed
            ? "RUNTIME_SOURCE_SANDBOX_FAILED"
            : "RUNTIME_SOURCE_SANDBOX_FALLBACK",
          message,
        });

        if (browserSourceSandboxFailClosed) {
          throw new Error(
            `Runtime source sandbox (${sandboxMode}) failed: ${message}`,
          );
        }
      }
    }

    const namespace = await input.withRemainingBudget(
      () =>
        input.importSourceModuleFromCode(
          rewritten,
          plan.moduleManifest,
          diagnostics,
        ),
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

    if (input.shouldUsePreactSourceRuntime(source)) {
      const preactArtifact = await input.createPreactRenderArtifact({
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
        ? await input.withRemainingBudget(
            async () =>
              (selected as (runtimeInput: unknown) => unknown)(runtimeInput),
            "Runtime source export execution timed out",
          )
        : selected;

    const normalized = input.normalizeSourceOutput(produced);
    if (!normalized) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_SOURCE_OUTPUT_INVALID",
        message: "Runtime source output is not a supported RuntimeNode payload",
      });
      return undefined;
    }

    return {
      root: normalized,
    };
  } catch (error) {
    if (input.isAbortError(error)) {
      throw error;
    }
    diagnostics.push({
      level: "error",
      code: "RUNTIME_SOURCE_EXEC_FAILED",
      message: input.errorToMessage(error),
    });
    return undefined;
  }
}
