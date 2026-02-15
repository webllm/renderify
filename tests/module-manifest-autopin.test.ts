import assert from "node:assert/strict";
import test from "node:test";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  autoPinRuntimePlanModuleManifest,
  type RuntimeManager,
  renderPlanInBrowser,
} from "../packages/runtime/src/index";
import type {
  RuntimeExecutionInput,
  RuntimeModuleLoader,
} from "../packages/runtime/src/runtime-manager.types";

class ResolveOnlyJspmLoader implements RuntimeModuleLoader {
  async load(_specifier: string): Promise<unknown> {
    return {};
  }

  resolveSpecifier(specifier: string): string {
    if (specifier === "date-fns") {
      return "https://ga.jspm.io/npm:date-fns";
    }

    return `https://ga.jspm.io/npm:${specifier}`;
  }
}

test("auto pin latest fills moduleManifest for bare source imports", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "autopin_bare_source_plan",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      runtime: "renderify",
      code: [
        'import { format } from "date-fns";',
        "export default function App(){",
        "  return { type: 'text', value: format(new Date(0), 'yyyy-MM-dd') };",
        "}",
      ].join("\n"),
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://ga.jspm.io/npm:date-fns") {
      return new Response("4.1.0", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (url === "https://ga.jspm.io/npm:date-fns@4.1.0/package.json") {
      return new Response(
        JSON.stringify({
          exports: {
            ".": {
              import: {
                default: "./index.js",
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const hydrated = await autoPinRuntimePlanModuleManifest(plan, {
      moduleLoader: new ResolveOnlyJspmLoader(),
    });

    assert.equal(
      hydrated.moduleManifest?.["date-fns"]?.resolvedUrl,
      "https://ga.jspm.io/npm:date-fns@4.1.0/index.js",
    );
    assert.equal(hydrated.moduleManifest?.["date-fns"]?.version, "4.1.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auto pin latest leaves existing moduleManifest entries unchanged", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "autopin_existing_manifest_plan",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    moduleManifest: {
      "date-fns": {
        resolvedUrl: "https://ga.jspm.io/npm:date-fns@4.0.0/index.js",
        version: "4.0.0",
      },
    },
    source: {
      language: "js",
      runtime: "renderify",
      code: [
        'import { format } from "date-fns";',
        "export default function App(){",
        "  return { type: 'text', value: format(new Date(0), 'yyyy-MM-dd') };",
        "}",
      ].join("\n"),
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called when manifest entry exists");
  }) as typeof fetch;

  try {
    const hydrated = await autoPinRuntimePlanModuleManifest(plan, {
      moduleLoader: new ResolveOnlyJspmLoader(),
    });

    assert.equal(hydrated, plan);
    assert.equal(
      hydrated.moduleManifest?.["date-fns"]?.resolvedUrl,
      "https://ga.jspm.io/npm:date-fns@4.0.0/index.js",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("renderPlanInBrowser auto-pins bare imports before security check", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "autopin_embed_integration_plan",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      runtime: "renderify",
      code: [
        'import { format } from "date-fns";',
        "export default function App(){",
        "  return { type: 'text', value: format(new Date(0), 'yyyy-MM-dd') };",
        "}",
      ].join("\n"),
    },
  };

  let executedPlan: RuntimePlan | undefined;

  const runtimeStub = {
    async initialize(): Promise<void> {},
    async terminate(): Promise<void> {},
    async probePlan(_plan: RuntimePlan): Promise<never> {
      throw new Error("not implemented");
    },
    async executePlan(_plan: RuntimePlan): Promise<never> {
      throw new Error("not implemented");
    },
    async execute(input: RuntimeExecutionInput) {
      executedPlan = input.plan;
      return {
        planId: input.plan.id,
        root: createElementNode("section", undefined, [createTextNode("ok")]),
        diagnostics: [],
      };
    },
    async compile(_plan: RuntimePlan): Promise<string> {
      return "";
    },
    getPlanState(_planId: string) {
      return undefined;
    },
    setPlanState(_planId: string): void {},
    clearPlanState(_planId: string): void {},
  } as unknown as RuntimeManager;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://ga.jspm.io/npm:date-fns") {
      return new Response("4.1.0", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (url === "https://ga.jspm.io/npm:date-fns@4.1.0/package.json") {
      return new Response(
        JSON.stringify({
          exports: {
            ".": {
              import: {
                default: "./index.js",
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await renderPlanInBrowser(plan, {
      runtime: runtimeStub,
      autoPinModuleLoader: new ResolveOnlyJspmLoader(),
      autoInitializeRuntime: false,
      autoTerminateRuntime: false,
    });

    assert.equal(result.html, "<section>ok</section>");
    assert.equal(
      executedPlan?.moduleManifest?.["date-fns"]?.resolvedUrl,
      "https://ga.jspm.io/npm:date-fns@4.1.0/index.js",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
