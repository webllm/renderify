import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  RuntimeDiagnostic,
  RuntimeModuleManifest,
} from "../packages/ir/src/index";
import {
  createRuntimeModuleMaterializationBudget,
  RuntimeModuleMaterializationLimitError,
} from "../packages/runtime/src/runtime-module-materialization-budget";
import { RuntimeSourceModuleLoader } from "../packages/runtime/src/runtime-source-module-loader";
import { rewriteImportsAsync } from "../packages/runtime/src/runtime-source-utils";

test("same-origin browser preact imports stay native while consuming module budget", async () => {
  const restoreBrowser = installBrowserGlobals();
  const restoreFetch = installMockFetch(async () =>
    createJavaScriptResponse("export default 1;"),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  const budget = createRuntimeModuleMaterializationBudget(1);
  const loader = createLoader({ diagnostics, budget });
  const hooksUrl =
    "https://app.example/node_modules/preact/hooks/dist/hooks.module.js";
  const jsxRuntimeUrl =
    "https://app.example/node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js";

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
    restoreFetch();
    restoreBrowser();
  }
});

test("same-origin preact companion imports stay on the same origin during audit", async () => {
  const restoreBrowser = installBrowserGlobals();
  const hooksUrl =
    "https://app.example/node_modules/preact/hooks/dist/hooks.module.js";
  const preactUrl =
    "https://app.example/node_modules/preact/dist/preact.module.js";
  const requestedUrls: string[] = [];
  const restoreFetch = installMockFetch(async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    return createJavaScriptResponse(
      url === hooksUrl
        ? 'import { options } from "preact"; export default options;'
        : "export default 1;",
    );
  });
  const loader = createLoader({
    diagnostics: [],
    budget: createRuntimeModuleMaterializationBudget(4),
    rewriteImportsAsync,
  });

  try {
    assert.equal(
      await loader.resolveRuntimeImportSpecifier(hooksUrl, undefined),
      hooksUrl,
    );
    assert.deepEqual(requestedUrls, [hooksUrl, preactUrl]);
  } finally {
    restoreFetch();
    restoreBrowser();
  }
});

test("preserved browser preact imports enforce transitive module budgets", async () => {
  const restoreBrowser = installBrowserGlobals();
  const rootUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const restoreFetch = installMockFetch(async () =>
    createJavaScriptResponse('import "./preact.module.js"; export default 1;'),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  const loader = createLoader({
    diagnostics,
    budget: createRuntimeModuleMaterializationBudget(1),
    rewriteImportsAsync: resolveStaticImports,
  });

  try {
    await assert.rejects(
      loader.resolveRuntimeImportSpecifier(rootUrl, undefined),
      RuntimeModuleMaterializationLimitError,
    );
    assert.equal(
      diagnostics.some(
        (item) => item.code === "RUNTIME_MODULE_MATERIALIZATION_LIMIT_EXCEEDED",
      ),
      true,
    );
  } finally {
    restoreFetch();
    restoreBrowser();
  }
});

test("preserved browser preact imports audit transitive network policy", async () => {
  const restoreBrowser = installBrowserGlobals();
  const rootUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const restoreFetch = installMockFetch(async () =>
    createJavaScriptResponse(
      'import "https://blocked.example/child.js"; export default 1;',
    ),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  const loader = createLoader({
    diagnostics,
    budget: createRuntimeModuleMaterializationBudget(4),
    rewriteImportsAsync: resolveStaticImports,
    isRemoteUrlAllowed: (url) => !url.includes("blocked.example"),
  });

  try {
    await assert.rejects(
      loader.resolveRuntimeImportSpecifier(rootUrl, undefined),
      /blocked by runtime network policy/,
    );
    assert.equal(
      diagnostics.some((item) => item.code === "RUNTIME_SOURCE_IMPORT_BLOCKED"),
      true,
    );
  } finally {
    restoreFetch();
    restoreBrowser();
  }
});

test("preserved browser preact imports reject redirects outside trusted package paths", async () => {
  const restoreBrowser = installBrowserGlobals();
  const rootUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const restoreFetch = installMockFetch(async () => {
    const response = createJavaScriptResponse("export default 1;");
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://attacker.example/not-preact.js",
    });
    return response;
  });
  const loader = createLoader({
    diagnostics: [],
    budget: createRuntimeModuleMaterializationBudget(4),
  });

  try {
    await assert.rejects(
      loader.resolveRuntimeImportSpecifier(rootUrl, undefined),
      /redirected outside trusted package paths/,
    );
  } finally {
    restoreFetch();
    restoreBrowser();
  }
});

test("preact-looking paths on untrusted origins are materialized instead of preserved", async () => {
  const restoreBrowser = installBrowserGlobals();
  const restoreFetch = installMockFetch(async () =>
    createJavaScriptResponse("export default 1;"),
  );
  const url =
    "https://attacker.example/node_modules/preact/hooks/dist/hooks.module.js";
  const loader = createLoader({
    diagnostics: [],
    budget: createRuntimeModuleMaterializationBudget(2),
  });

  try {
    const resolved = await loader.resolveRuntimeImportSpecifier(url, undefined);
    assert.notEqual(resolved, url);
    assert.match(resolved, /^data:text\/javascript,/);
  } finally {
    restoreFetch();
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

test("remote module timeout covers stalled response bodies and cancels the reader", async () => {
  let readerCancelled = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("export default 1;"));
        },
        cancel() {
          readerCancelled = true;
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/javascript",
        },
      },
    );

  const loader = createLoader({
    diagnostics: [],
    budget: createRuntimeModuleMaterializationBudget(4),
    timeoutMs: 20,
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      loader.fetchRemoteModuleCodeWithFallback(
        "https://modules.example/stalled.js",
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "TimeoutError" &&
        error.message.includes("stalled.js"),
    );
    assert.ok(Date.now() - startedAt < 500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readerCancelled, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("remote module probes verify only the entry without materializing its graph", async () => {
  const rootUrl = "https://modules.example/root.js";
  const source = 'import "./child.js"; export default 1;';
  const requestedUrls: string[] = [];
  let rewriteCalls = 0;
  const restoreFetch = installMockFetch(async (input) => {
    requestedUrls.push(String(input));
    return createJavaScriptResponse(source);
  });
  const budget = createRuntimeModuleMaterializationBudget(0);
  const loader = createLoader({
    diagnostics: [],
    budget,
    moduleManifest: {
      root: {
        resolvedUrl: rootUrl,
        integrity: `sha256-${createHash("sha256").update(source).digest("base64")}`,
      },
    },
    rewriteImportsAsync: async (code) => {
      rewriteCalls += 1;
      return code;
    },
  });

  try {
    const fetched = await loader.probeRemoteModule(rootUrl);
    assert.equal(fetched.code, source);
    assert.deepEqual(requestedUrls, [rootUrl]);
    assert.equal(rewriteCalls, 0);
    assert.equal(budget.materializedKeys.size, 0);
  } finally {
    restoreFetch();
  }
});

function createLoader(input: {
  cache?: Map<string, string>;
  budget: ReturnType<typeof createRuntimeModuleMaterializationBudget>;
  diagnostics: RuntimeDiagnostic[];
  timeoutMs?: number;
  rewriteImportsAsync?: (
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ) => Promise<string>;
  moduleManifest?: RuntimeModuleManifest;
  isRemoteUrlAllowed?: (url: string) => boolean;
}): RuntimeSourceModuleLoader {
  return new RuntimeSourceModuleLoader({
    moduleManifest: input.moduleManifest,
    diagnostics: input.diagnostics,
    materializedModuleUrlCache: input.cache ?? new Map(),
    materializedModuleInflight: new Map(),
    remoteFallbackCdnBases: [],
    remoteFetchTimeoutMs: input.timeoutMs ?? 100,
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 0,
    remoteModuleMaxBytes: 1024,
    canMaterializeRuntimeModules: () => true,
    rewriteImportsAsync:
      input.rewriteImportsAsync ?? (async (code: string) => code),
    createInlineModuleUrl: (code) => `data:text/javascript,${code}`,
    resolveRuntimeSourceSpecifier: (specifier) => specifier,
    isRemoteUrlAllowed: input.isRemoteUrlAllowed ?? (() => true),
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
      value:
        key === "window"
          ? {
              location: {
                origin: "https://app.example",
              },
            }
          : {},
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

function installMockFetch(implementation: typeof fetch): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function createJavaScriptResponse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: {
      "content-type": "text/javascript",
    },
  });
}

async function resolveStaticImports(
  code: string,
  resolver: (specifier: string) => Promise<string>,
): Promise<string> {
  const matches = code.matchAll(/\bimport\s+["']([^"']+)["']/g);
  for (const match of matches) {
    const specifier = match[1];
    if (specifier) {
      await resolver(specifier);
    }
  }
  return code;
}
