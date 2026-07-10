import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeDiagnostic } from "../packages/ir/src/index";
import {
  createRuntimeModuleMaterializationBudget,
  RuntimeModuleMaterializationLimitError,
} from "../packages/runtime/src/runtime-module-materialization-budget";
import { RuntimeSourceModuleLoader } from "../packages/runtime/src/runtime-source-module-loader";

test("browser preact imports stay native while consuming module budget", async () => {
  const restoreBrowser = installBrowserGlobals();
  const diagnostics: RuntimeDiagnostic[] = [];
  const budget = createRuntimeModuleMaterializationBudget(1);
  const loader = createLoader({ diagnostics, budget });
  const hooksUrl =
    "https://cdn.example.com/node_modules/preact/hooks/dist/hooks.module.js";
  const jsxRuntimeUrl =
    "https://cdn.example.com/node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js";

  try {
    assert.equal(
      await loader.resolveRuntimeImportSpecifier(hooksUrl, undefined),
      hooksUrl,
    );
    assert.equal(budget.materializedKeys.size, 1);

    await assert.rejects(
      loader.resolveRuntimeImportSpecifier(jsxRuntimeUrl, undefined),
      RuntimeModuleMaterializationLimitError,
    );
    assert.equal(
      diagnostics.some(
        (item) => item.code === "RUNTIME_MODULE_MATERIALIZATION_LIMIT_EXCEEDED",
      ),
      true,
    );
  } finally {
    restoreBrowser();
  }
});

test("cached remote modules still consume the current execution budget", async () => {
  const url = "https://cdn.example.com/cached.mjs";
  const cache = new Map([[url, "data:text/javascript,export default 1"]]);
  const budget = createRuntimeModuleMaterializationBudget(0);
  const loader = createLoader({ cache, budget, diagnostics: [] });

  await assert.rejects(
    loader.resolveRuntimeImportSpecifier(url, undefined),
    RuntimeModuleMaterializationLimitError,
  );
});

function createLoader(input: {
  cache?: Map<string, string>;
  budget: ReturnType<typeof createRuntimeModuleMaterializationBudget>;
  diagnostics: RuntimeDiagnostic[];
}): RuntimeSourceModuleLoader {
  return new RuntimeSourceModuleLoader({
    moduleManifest: undefined,
    diagnostics: input.diagnostics,
    materializedModuleUrlCache: input.cache ?? new Map(),
    materializedModuleInflight: new Map(),
    remoteFallbackCdnBases: [],
    remoteFetchTimeoutMs: 100,
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 0,
    remoteModuleMaxBytes: 1024,
    canMaterializeRuntimeModules: () => true,
    rewriteImportsAsync: async (code) => code,
    createInlineModuleUrl: (code) => `data:text/javascript,${code}`,
    resolveRuntimeSourceSpecifier: (specifier) => specifier,
    isRemoteUrlAllowed: () => true,
    materializationBudget: input.budget,
  });
}

function installBrowserGlobals(): () => void {
  const root = globalThis as Record<string, unknown>;
  const previous = new Map(
    ["window", "document", "navigator"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(root, key),
    ]),
  );

  for (const key of previous.keys()) {
    Object.defineProperty(root, key, {
      configurable: true,
      writable: true,
      value: {},
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(root, key, descriptor);
      } else {
        Reflect.deleteProperty(root, key);
      }
    }
  };
}
