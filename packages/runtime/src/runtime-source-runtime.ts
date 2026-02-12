import type {
  RuntimeExecutionProfile,
  RuntimeSourceModule,
} from "@renderify/ir";
import { BabelRuntimeSourceTranspiler } from "./transpiler";

export type RuntimeSourceSandboxMode = "none" | "worker" | "iframe";

export interface RuntimeSourceTranspilerLike {
  transpile(input: {
    code: string;
    language: RuntimeSourceModule["language"];
    filename?: string;
    runtime?: RuntimeSourceModule["runtime"];
  }): Promise<string>;
}

export function shouldUsePreactSourceRuntime(
  source: RuntimeSourceModule,
): boolean {
  return source.runtime === "preact";
}

export function executionProfileToSourceSandboxMode(
  executionProfile: RuntimeExecutionProfile,
): RuntimeSourceSandboxMode | undefined {
  if (executionProfile === "sandbox-worker") {
    return "worker";
  }

  if (executionProfile === "sandbox-iframe") {
    return "iframe";
  }

  return undefined;
}

export function resolveSourceSandboxMode(input: {
  source: RuntimeSourceModule;
  executionProfile: RuntimeExecutionProfile;
  defaultMode: RuntimeSourceSandboxMode;
  isBrowserRuntime: boolean;
}): RuntimeSourceSandboxMode {
  const requested = executionProfileToSourceSandboxMode(input.executionProfile);
  const mode = requested ?? input.defaultMode;

  if (mode === "none") {
    return "none";
  }

  if (!input.isBrowserRuntime) {
    return "none";
  }

  if (shouldUsePreactSourceRuntime(input.source)) {
    if (requested) {
      throw new Error(
        `${requested} executionProfile is not supported with source.runtime=preact`,
      );
    }
    return "none";
  }

  return mode;
}

export async function transpileRuntimeSource(
  source: RuntimeSourceModule,
  sourceTranspiler: RuntimeSourceTranspilerLike,
): Promise<string> {
  const mergedSource = BabelRuntimeSourceTranspiler.mergeRuntimeHelpers(
    source.code,
    source.runtime,
  );
  return sourceTranspiler.transpile({
    code: mergedSource,
    language: source.language,
    filename: `renderify-runtime-source.${source.language}`,
    runtime: source.runtime,
  });
}
