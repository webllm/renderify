import type { RuntimeDiagnostic, RuntimeModuleManifest } from "@renderify/ir";

export interface RuntimePlanImportResolutionInput {
  imports: string[];
  maxImports: number;
  moduleManifest: RuntimeModuleManifest | undefined;
  diagnostics: RuntimeDiagnostic[];
  moduleLoader?: {
    load(specifier: string): Promise<unknown>;
  };
  resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): string | undefined;
  isAborted(): boolean;
  hasExceededBudget(): boolean;
  withRemainingBudget<T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
  isAbortError(error: unknown): boolean;
  errorToMessage(error: unknown): string;
}

export async function resolveRuntimePlanImports(
  input: RuntimePlanImportResolutionInput,
): Promise<void> {
  const { imports, maxImports, moduleManifest, diagnostics } = input;

  for (let i = 0; i < imports.length; i += 1) {
    if (input.isAborted()) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_ABORTED",
        message: "Execution aborted before import resolution",
      });
      break;
    }

    const specifier = imports[i];
    const resolvedSpecifier = input.resolveRuntimeSpecifier(
      specifier,
      moduleManifest,
      diagnostics,
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

    if (!input.moduleLoader) {
      diagnostics.push({
        level: "warning",
        code: "RUNTIME_LOADER_MISSING",
        message: `Import skipped because no module loader is configured: ${resolvedSpecifier}`,
      });
      continue;
    }

    if (input.hasExceededBudget()) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_TIMEOUT",
        message: `Execution time budget exceeded before importing: ${specifier}`,
      });
      break;
    }

    try {
      await input.withRemainingBudget(
        () => input.moduleLoader!.load(resolvedSpecifier),
        `Import timed out: ${resolvedSpecifier}`,
      );
    } catch (error) {
      if (input.isAbortError(error)) {
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
        message: `${resolvedSpecifier}: ${input.errorToMessage(error)}`,
      });
    }
  }
}
