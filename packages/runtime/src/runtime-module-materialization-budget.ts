import type { RuntimeDiagnostic } from "@renderify/ir";
import type { RuntimeModuleLoader } from "./runtime-manager.types";

export interface RuntimeModuleMaterializationBudget {
  readonly maxImports: number;
  readonly materializedKeys: Set<string>;
  readonly rollbackCacheMutations: Array<() => void>;
  exceededBy?: {
    cacheKey: string;
    url: string;
  };
}

export interface RuntimeModuleLoadOptions {
  materializationBudget?: RuntimeModuleMaterializationBudget;
  diagnostics?: RuntimeDiagnostic[];
}

interface BudgetAwareRuntimeModuleLoader {
  load(specifier: string, options: RuntimeModuleLoadOptions): Promise<unknown>;
  loadVerified?(
    specifier: string,
    integrity: string,
    options: RuntimeModuleLoadOptions,
  ): Promise<unknown>;
}

const BUDGET_AWARE_RUNTIME_MODULE_LOADERS = new WeakMap<
  RuntimeModuleLoader,
  BudgetAwareRuntimeModuleLoader
>();

export function registerBudgetAwareRuntimeModuleLoader(
  loader: RuntimeModuleLoader,
  implementation: BudgetAwareRuntimeModuleLoader,
): void {
  BUDGET_AWARE_RUNTIME_MODULE_LOADERS.set(loader, implementation);
}

export function loadRuntimeModuleWithBudget(
  loader: RuntimeModuleLoader,
  specifier: string,
  options: RuntimeModuleLoadOptions,
): Promise<unknown> {
  const implementation = BUDGET_AWARE_RUNTIME_MODULE_LOADERS.get(loader);
  return implementation
    ? implementation.load(specifier, options)
    : loader.load(specifier);
}

export function loadVerifiedRuntimeModuleWithBudget(
  loader: RuntimeModuleLoader,
  specifier: string,
  integrity: string,
  options: RuntimeModuleLoadOptions,
): Promise<unknown> {
  const implementation = BUDGET_AWARE_RUNTIME_MODULE_LOADERS.get(loader);
  if (implementation?.loadVerified) {
    return implementation.loadVerified(specifier, integrity, options);
  }
  if (!loader.loadVerified) {
    throw new Error(
      `Module loader cannot verify integrity-pinned remote module: ${specifier}`,
    );
  }
  return loader.loadVerified(specifier, integrity);
}

export class RuntimeModuleMaterializationLimitError extends Error {
  readonly code = "RUNTIME_MODULE_MATERIALIZATION_LIMIT_EXCEEDED";

  constructor(
    readonly maxImports: number,
    readonly url: string,
  ) {
    super(
      `Remote module materialization limit exceeded (maxImports=${maxImports}): ${url}`,
    );
    this.name = "RuntimeModuleMaterializationLimitError";
  }
}

export function createRuntimeModuleMaterializationBudget(
  maxImports: number,
): RuntimeModuleMaterializationBudget {
  return {
    maxImports: normalizeMaxImports(maxImports),
    materializedKeys: new Set<string>(),
    rollbackCacheMutations: [],
  };
}

export function claimRuntimeModuleMaterialization(
  budget: RuntimeModuleMaterializationBudget,
  cacheKey: string,
  url: string,
): void {
  if (budget.exceededBy) {
    throw new RuntimeModuleMaterializationLimitError(
      budget.maxImports,
      budget.exceededBy.url,
    );
  }

  if (budget.materializedKeys.has(cacheKey)) {
    return;
  }

  if (budget.materializedKeys.size >= budget.maxImports) {
    budget.exceededBy = { cacheKey, url };
    rollbackRuntimeModuleMaterializationCache(budget);
    throw new RuntimeModuleMaterializationLimitError(budget.maxImports, url);
  }

  budget.materializedKeys.add(cacheKey);
}

export function assertRuntimeModuleMaterializationBudgetActive(
  budget: RuntimeModuleMaterializationBudget | undefined,
): void {
  if (!budget?.exceededBy) {
    return;
  }

  throw new RuntimeModuleMaterializationLimitError(
    budget.maxImports,
    budget.exceededBy.url,
  );
}

export function setBudgetedMapEntryWithLimit<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maxEntries: number,
  budget: RuntimeModuleMaterializationBudget | undefined,
): void {
  const hadPrevious = map.has(key);
  const previous = map.get(key);

  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);

  const evicted: Array<[Key, Value]> = [];
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldestValue = map.get(oldestKey);
    map.delete(oldestKey);
    evicted.push([oldestKey, oldestValue as Value]);
  }

  if (!budget) {
    return;
  }

  budget.rollbackCacheMutations.push(() => {
    if (map.get(key) === value) {
      map.delete(key);
      if (hadPrevious) {
        map.set(key, previous as Value);
      }
    }

    for (const [evictedKey, evictedValue] of evicted) {
      if (!map.has(evictedKey)) {
        map.set(evictedKey, evictedValue);
      }
    }
  });
}

export function isRuntimeModuleMaterializationLimitError(
  error: unknown,
): error is RuntimeModuleMaterializationLimitError {
  return error instanceof RuntimeModuleMaterializationLimitError;
}

function rollbackRuntimeModuleMaterializationCache(
  budget: RuntimeModuleMaterializationBudget,
): void {
  for (let i = budget.rollbackCacheMutations.length - 1; i >= 0; i -= 1) {
    budget.rollbackCacheMutations[i]?.();
  }
  budget.rollbackCacheMutations.length = 0;
}

function normalizeMaxImports(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}
