import assert from "node:assert/strict";
import test from "node:test";
import {
  createComponentNode,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimeDiagnostic,
  type RuntimeModuleManifest,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  collectDependencyProbes,
  type DependencyProbe,
  executeDependencyProbe,
  type RuntimeDependencyProbeExecutor,
  runDependencyPreflight,
} from "../packages/runtime/src/runtime-preflight";

function createPlan(overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "preflight_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    imports: ["npm:pkg-a", "npm:pkg-a", "npm:pkg-b"],
    root: createElementNode("main", undefined, [
      createComponentNode("npm:cmp-a"),
      createComponentNode("npm:cmp-a"),
      createTextNode("ok"),
    ]),
    source: {
      language: "js",
      code: 'import "npm:src-a"; import "npm:src-a"; import("npm:src-b");',
    },
    ...overrides,
  };
}

function createExecutor(
  overrides: Partial<RuntimeDependencyProbeExecutor> = {},
): RuntimeDependencyProbeExecutor {
  return {
    moduleLoader: {
      async load(_specifier: string): Promise<unknown> {
        return {};
      },
    },
    async withRemainingBudget<T>(
      operation: () => Promise<T>,
      _timeoutMessage: string,
    ): Promise<T> {
      return operation();
    },
    resolveRuntimeSourceSpecifier(
      specifier: string,
      _moduleManifest: RuntimeModuleManifest | undefined,
      _diagnostics: RuntimeDiagnostic[],
      _requireManifest?: boolean,
    ): string {
      return specifier;
    },
    resolveSourceImportLoaderCandidate(
      _specifier: string,
      _moduleManifest: RuntimeModuleManifest | undefined,
    ): string | undefined {
      return undefined;
    },
    resolveRuntimeSpecifier(
      specifier: string,
      _moduleManifest: RuntimeModuleManifest | undefined,
      _diagnostics: RuntimeDiagnostic[],
      _usage,
    ): string | undefined {
      return `resolved:${specifier}`;
    },
    isHttpUrl(specifier: string): boolean {
      return specifier.startsWith("https://");
    },
    canMaterializeBrowserModules(): boolean {
      return false;
    },
    async materializeBrowserRemoteModule(_url: string): Promise<string> {
      return "blob:module";
    },
    async fetchRemoteModuleCodeWithFallback(_url: string): Promise<unknown> {
      return { ok: true };
    },
    isAbortError(error: unknown): boolean {
      return error instanceof Error && error.name === "AbortError";
    },
    errorToMessage(error: unknown): string {
      return error instanceof Error ? error.message : String(error);
    },
    ...overrides,
  };
}

test("preflight collectDependencyProbes deduplicates imports/components/source-imports", async () => {
  const plan = createPlan();

  const probes = await collectDependencyProbes(plan, async () => [
    "npm:src-a",
    "npm:src-a",
    "npm:src-b",
  ]);

  assert.deepEqual(
    probes.map((probe) => `${probe.usage}:${probe.specifier}`).sort(),
    [
      "component:npm:cmp-a",
      "import:npm:pkg-a",
      "import:npm:pkg-b",
      "source-import:npm:src-a",
      "source-import:npm:src-b",
    ],
  );
});

test("preflight runDependencyPreflight aborts and records diagnostic", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const probes: DependencyProbe[] = [
    { usage: "import", specifier: "npm:pkg-a" },
    { usage: "import", specifier: "npm:pkg-b" },
  ];

  const statuses = await runDependencyPreflight(
    probes,
    diagnostics,
    async (probe) => ({
      usage: probe.usage,
      specifier: probe.specifier,
      ok: true,
    }),
    {
      isAborted: () => true,
      hasExceededBudget: () => false,
    },
  );

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].ok, false);
  assert.equal(diagnostics[0].code, "RUNTIME_ABORTED");
});

test("preflight runDependencyPreflight stops when execution budget is exceeded", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const probes: DependencyProbe[] = [
    { usage: "import", specifier: "npm:pkg-a" },
  ];

  const statuses = await runDependencyPreflight(
    probes,
    diagnostics,
    async (probe) => ({
      usage: probe.usage,
      specifier: probe.specifier,
      ok: true,
    }),
    {
      isAborted: () => false,
      hasExceededBudget: () => true,
    },
  );

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].ok, false);
  assert.equal(diagnostics[0].code, "RUNTIME_TIMEOUT");
});

test("preflight executeDependencyProbe rejects unresolved relative source imports", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];

  const status = await executeDependencyProbe(
    { usage: "source-import", specifier: "./relative.js" },
    undefined,
    diagnostics,
    createExecutor({
      resolveRuntimeSourceSpecifier() {
        return "./relative.js";
      },
    }),
  );

  assert.equal(status.ok, false);
  assert.equal(status.message, "Relative source import could not be resolved");
  assert.ok(
    diagnostics.some(
      (item) =>
        item.code === "RUNTIME_PREFLIGHT_SOURCE_IMPORT_RELATIVE_UNRESOLVED",
    ),
  );
});

test("preflight executeDependencyProbe loads source import via module loader candidate", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const loaded: string[] = [];

  const status = await executeDependencyProbe(
    { usage: "source-import", specifier: "npm:chart" },
    undefined,
    diagnostics,
    createExecutor({
      resolveSourceImportLoaderCandidate() {
        return "https://ga.jspm.io/npm:chart@1";
      },
      moduleLoader: {
        async load(specifier: string): Promise<unknown> {
          loaded.push(specifier);
          return { ok: true };
        },
      },
    }),
  );

  assert.equal(status.ok, true);
  assert.equal(status.resolvedSpecifier, "https://ga.jspm.io/npm:chart@1");
  assert.deepEqual(loaded, ["https://ga.jspm.io/npm:chart@1"]);
});

test("preflight executeDependencyProbe uses http fetch path for source imports", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const fetchedUrls: string[] = [];

  const status = await executeDependencyProbe(
    { usage: "source-import", specifier: "https://esm.sh/nanoid@5" },
    undefined,
    diagnostics,
    createExecutor({
      moduleLoader: undefined,
      resolveRuntimeSourceSpecifier() {
        return "https://esm.sh/nanoid@5";
      },
      async fetchRemoteModuleCodeWithFallback(url: string): Promise<unknown> {
        fetchedUrls.push(url);
        return { ok: true };
      },
    }),
  );

  assert.equal(status.ok, true);
  assert.deepEqual(fetchedUrls, ["https://esm.sh/nanoid@5"]);
});

test("preflight executeDependencyProbe reports skipped status when loader is missing", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];

  const status = await executeDependencyProbe(
    { usage: "import", specifier: "npm:pkg-a" },
    undefined,
    diagnostics,
    createExecutor({
      moduleLoader: undefined,
      resolveRuntimeSpecifier(specifier: string): string {
        return `https://ga.jspm.io/${specifier}`;
      },
    }),
  );

  assert.equal(status.ok, false);
  assert.match(String(status.message), /module loader is missing/);
  assert.ok(
    diagnostics.some((item) => item.code === "RUNTIME_PREFLIGHT_SKIPPED"),
  );
});

test("preflight executeDependencyProbe handles component probe failure and abort", async () => {
  const diagnosticsFailure: RuntimeDiagnostic[] = [];

  const failure = await executeDependencyProbe(
    { usage: "component", specifier: "npm:cmp-a" },
    undefined,
    diagnosticsFailure,
    createExecutor({
      moduleLoader: {
        async load(): Promise<unknown> {
          throw new Error("load failed");
        },
      },
    }),
  );

  assert.equal(failure.ok, false);
  assert.match(String(failure.message), /load failed/);
  assert.ok(
    diagnosticsFailure.some(
      (item) => item.code === "RUNTIME_PREFLIGHT_COMPONENT_FAILED",
    ),
  );

  const diagnosticsAbort: RuntimeDiagnostic[] = [];
  const abortError = new Error("aborted");
  abortError.name = "AbortError";

  const aborted = await executeDependencyProbe(
    { usage: "import", specifier: "npm:pkg-a" },
    undefined,
    diagnosticsAbort,
    createExecutor({
      moduleLoader: {
        async load(): Promise<unknown> {
          throw abortError;
        },
      },
    }),
  );

  assert.equal(aborted.ok, false);
  assert.equal(aborted.message, "Dependency preflight aborted");
  assert.ok(diagnosticsAbort.some((item) => item.code === "RUNTIME_ABORTED"));
});
