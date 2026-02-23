import type {
  RuntimeDiagnostic,
  RuntimeModuleManifest,
  RuntimePlan,
} from "@renderify/ir";
import {
  collectDependencyProbes,
  executeDependencyProbe,
  type RuntimeDependencyProbeStatus,
  type RuntimeDependencyUsage,
  runDependencyPreflight,
} from "./runtime-preflight";
import {
  canMaterializeBrowserModules,
  parseImportSpecifiersFromSource,
} from "./runtime-source-utils";
import { isHttpUrl } from "./runtime-specifier";

export interface RuntimePlanPreflightInput {
  plan: RuntimePlan;
  diagnostics: RuntimeDiagnostic[];
  moduleLoader?: {
    load(specifier: string): Promise<unknown>;
  };
  withRemainingBudget<T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
  resolveRuntimeSourceSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest?: boolean,
  ): string;
  resolveSourceImportLoaderCandidate(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): string | undefined;
  resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    usage: RuntimeDependencyUsage,
  ): string | undefined;
  isResolvedSpecifierAllowed?(
    specifier: string,
    usage: RuntimeDependencyUsage,
    diagnostics: RuntimeDiagnostic[],
  ): boolean;
  materializeBrowserRemoteModule(
    url: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<string>;
  fetchRemoteModuleCodeWithFallback(
    url: string,
    diagnostics: RuntimeDiagnostic[],
  ): Promise<unknown>;
  isAbortError(error: unknown): boolean;
  errorToMessage(error: unknown): string;
  isAborted(): boolean;
  hasExceededBudget(): boolean;
}

export async function preflightRuntimePlanDependencies(
  input: RuntimePlanPreflightInput,
): Promise<RuntimeDependencyProbeStatus[]> {
  const probes = await collectDependencyProbes(
    input.plan,
    parseSourceImportSpecifiers,
  );

  return runDependencyPreflight(
    probes,
    input.diagnostics,
    (probe) =>
      executeDependencyProbe(
        probe,
        input.plan.moduleManifest,
        input.diagnostics,
        {
          moduleLoader: input.moduleLoader,
          withRemainingBudget: (operation, timeoutMessage) =>
            input.withRemainingBudget(operation, timeoutMessage),
          resolveRuntimeSourceSpecifier: (
            specifier,
            manifest,
            diagnostics,
            requireManifest,
          ) =>
            input.resolveRuntimeSourceSpecifier(
              specifier,
              manifest,
              diagnostics,
              requireManifest,
            ),
          resolveSourceImportLoaderCandidate: (specifier, manifest) =>
            input.resolveSourceImportLoaderCandidate(specifier, manifest),
          resolveRuntimeSpecifier: (specifier, manifest, diagnostics, usage) =>
            input.resolveRuntimeSpecifier(
              specifier,
              manifest,
              diagnostics,
              usage,
            ),
          isResolvedSpecifierAllowed: (specifier, usage, diagnostics) =>
            input.isResolvedSpecifierAllowed?.(specifier, usage, diagnostics),
          isHttpUrl,
          canMaterializeBrowserModules: () => canMaterializeBrowserModules(),
          materializeBrowserRemoteModule: (url, manifest, diagnostics) =>
            input.materializeBrowserRemoteModule(url, manifest, diagnostics),
          fetchRemoteModuleCodeWithFallback: (url, diagnostics) =>
            input.fetchRemoteModuleCodeWithFallback(url, diagnostics),
          isAbortError: (error) => input.isAbortError(error),
          errorToMessage: (error) => input.errorToMessage(error),
        },
      ),
    {
      isAborted: () => input.isAborted(),
      hasExceededBudget: () => input.hasExceededBudget(),
    },
  );
}

async function parseSourceImportSpecifiers(code: string): Promise<string[]> {
  if (code.trim().length === 0) {
    return [];
  }

  const imports = new Set<string>();
  const parsedSpecifiers = await parseImportSpecifiersFromSource(code);
  for (const entry of parsedSpecifiers) {
    imports.add(entry.specifier);
  }

  return [...imports];
}
