import {
  collectComponentModules,
  type RuntimeDiagnostic,
  type RuntimeModuleManifest,
  type RuntimePlan,
} from "@renderify/ir";

export type RuntimeDependencyUsage = "import" | "component" | "source-import";

export interface RuntimeDependencyProbeStatus {
  usage: RuntimeDependencyUsage;
  specifier: string;
  resolvedSpecifier?: string;
  ok: boolean;
  message?: string;
}

export interface DependencyProbe {
  usage: RuntimeDependencyUsage;
  specifier: string;
}

export async function collectDependencyProbes(
  plan: RuntimePlan,
  parseSourceImportSpecifiers: (code: string) => Promise<string[]>,
): Promise<DependencyProbe[]> {
  const probes: DependencyProbe[] = [];
  const seen = new Set<string>();

  const pushProbe = (usage: RuntimeDependencyUsage, specifier: unknown) => {
    if (typeof specifier !== "string") {
      return;
    }

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

  const declaredImports = Array.isArray(plan.imports) ? plan.imports : [];
  for (const specifier of declaredImports) {
    pushProbe("import", specifier);
  }

  for (const specifier of collectComponentModules(plan.root)) {
    pushProbe("component", specifier);
  }

  if (plan.source) {
    const sourceImports = await parseSourceImportSpecifiers(plan.source.code);
    for (const specifier of sourceImports) {
      pushProbe("source-import", specifier);
    }
  }

  return probes;
}

export async function runDependencyPreflight(
  probes: DependencyProbe[],
  diagnostics: RuntimeDiagnostic[],
  probeExecutor: (
    probe: DependencyProbe,
  ) => Promise<RuntimeDependencyProbeStatus>,
  options: {
    isAborted: () => boolean;
    hasExceededBudget: () => boolean;
  },
): Promise<RuntimeDependencyProbeStatus[]> {
  const statuses: RuntimeDependencyProbeStatus[] = [];

  for (const probe of probes) {
    if (options.isAborted()) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_ABORTED",
        message: `Execution aborted during dependency preflight (${probe.usage}:${probe.specifier})`,
      });
      statuses.push({
        usage: probe.usage,
        specifier: probe.specifier,
        ok: false,
        message: "Dependency preflight aborted",
      });
      return statuses;
    }

    if (options.hasExceededBudget()) {
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

    statuses.push(await probeExecutor(probe));
  }

  return statuses;
}

export interface RuntimeDependencyProbeExecutor {
  moduleLoader?: {
    load(specifier: string): Promise<unknown>;
  };
  isResolvedSpecifierAllowed?(
    specifier: string,
    usage: RuntimeDependencyUsage,
    diagnostics: RuntimeDiagnostic[],
  ): boolean;
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
  isHttpUrl(specifier: string): boolean;
  canMaterializeBrowserModules(): boolean;
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
}

export async function executeDependencyProbe(
  probe: DependencyProbe,
  moduleManifest: RuntimeModuleManifest | undefined,
  diagnostics: RuntimeDiagnostic[],
  executor: RuntimeDependencyProbeExecutor,
): Promise<RuntimeDependencyProbeStatus> {
  if (probe.usage === "source-import") {
    const resolved = executor.resolveRuntimeSourceSpecifier(
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
    const loaderCandidate = executor.resolveSourceImportLoaderCandidate(
      probe.specifier,
      moduleManifest,
    );

    try {
      if (executor.moduleLoader && loaderCandidate) {
        if (
          executor.isResolvedSpecifierAllowed &&
          !executor.isResolvedSpecifierAllowed(
            loaderCandidate,
            probe.usage,
            diagnostics,
          )
        ) {
          return {
            usage: probe.usage,
            specifier: probe.specifier,
            resolvedSpecifier: loaderCandidate,
            ok: false,
            message: "Blocked by runtime network policy",
          };
        }

        await executor.withRemainingBudget(
          () => executor.moduleLoader!.load(loaderCandidate),
          timeoutMessage,
        );
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: loaderCandidate,
          ok: true,
        };
      }

      if (executor.isHttpUrl(resolved)) {
        if (
          executor.isResolvedSpecifierAllowed &&
          !executor.isResolvedSpecifierAllowed(
            resolved,
            probe.usage,
            diagnostics,
          )
        ) {
          return {
            usage: probe.usage,
            specifier: probe.specifier,
            resolvedSpecifier: resolved,
            ok: false,
            message: "Blocked by runtime network policy",
          };
        }

        await executor.withRemainingBudget(async () => {
          if (executor.canMaterializeBrowserModules()) {
            await executor.materializeBrowserRemoteModule(
              resolved,
              moduleManifest,
              diagnostics,
            );
          } else {
            await executor.fetchRemoteModuleCodeWithFallback(
              resolved,
              diagnostics,
            );
          }
        }, timeoutMessage);
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: true,
        };
      }

      if (!executor.moduleLoader) {
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

      if (
        executor.isResolvedSpecifierAllowed &&
        !executor.isResolvedSpecifierAllowed(resolved, probe.usage, diagnostics)
      ) {
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: false,
          message: "Blocked by runtime network policy",
        };
      }

      await executor.withRemainingBudget(
        () => executor.moduleLoader!.load(resolved),
        timeoutMessage,
      );
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: true,
      };
    } catch (error) {
      if (executor.isAbortError(error)) {
        diagnostics.push({
          level: "error",
          code: "RUNTIME_ABORTED",
          message: `${probe.specifier}: dependency preflight aborted`,
        });
        return {
          usage: probe.usage,
          specifier: probe.specifier,
          resolvedSpecifier: resolved,
          ok: false,
          message: "Dependency preflight aborted",
        };
      }
      diagnostics.push({
        level: "error",
        code: "RUNTIME_PREFLIGHT_SOURCE_IMPORT_FAILED",
        message: `${probe.specifier}: ${executor.errorToMessage(error)}`,
      });
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: false,
        message: executor.errorToMessage(error),
      };
    }
  }

  const resolved = executor.resolveRuntimeSpecifier(
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

  if (!executor.moduleLoader) {
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
      message: "Dependency preflight skipped because module loader is missing",
    };
  }

  if (
    executor.isResolvedSpecifierAllowed &&
    !executor.isResolvedSpecifierAllowed(resolved, probe.usage, diagnostics)
  ) {
    return {
      usage: probe.usage,
      specifier: probe.specifier,
      resolvedSpecifier: resolved,
      ok: false,
      message: "Blocked by runtime network policy",
    };
  }

  try {
    await executor.withRemainingBudget(
      () => executor.moduleLoader!.load(resolved),
      `Dependency preflight timed out: ${resolved}`,
    );
    return {
      usage: probe.usage,
      specifier: probe.specifier,
      resolvedSpecifier: resolved,
      ok: true,
    };
  } catch (error) {
    if (executor.isAbortError(error)) {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_ABORTED",
        message: `${resolved}: dependency preflight aborted`,
      });
      return {
        usage: probe.usage,
        specifier: probe.specifier,
        resolvedSpecifier: resolved,
        ok: false,
        message: "Dependency preflight aborted",
      };
    }
    diagnostics.push({
      level: "error",
      code:
        probe.usage === "component"
          ? "RUNTIME_PREFLIGHT_COMPONENT_FAILED"
          : "RUNTIME_PREFLIGHT_IMPORT_FAILED",
      message: `${resolved}: ${executor.errorToMessage(error)}`,
    });
    return {
      usage: probe.usage,
      specifier: probe.specifier,
      resolvedSpecifier: resolved,
      ok: false,
      message: executor.errorToMessage(error),
    };
  }
}
