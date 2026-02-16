import assert from "node:assert/strict";
import test from "node:test";
import { JspmModuleLoader } from "../packages/runtime/src/index";

test("runtime-jspm resolves known overrides for preact/recharts", () => {
  const loader = new JspmModuleLoader();

  assert.equal(
    loader.resolveSpecifier("preact"),
    "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  );
  assert.equal(
    loader.resolveSpecifier("recharts"),
    "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
  );
});

test("runtime-jspm resolves bare package and npm: package specifiers", () => {
  const loader = new JspmModuleLoader();

  assert.equal(
    loader.resolveSpecifier("react"),
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  );
  assert.equal(
    loader.resolveSpecifier("npm:react-dom/client"),
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  );
  assert.equal(
    loader.resolveSpecifier("react/jsx-runtime"),
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  );
  assert.equal(
    loader.resolveSpecifier("npm:nanoid@5"),
    "https://ga.jspm.io/npm:nanoid@5",
  );
  assert.equal(
    loader.resolveSpecifier("@mui/material"),
    "https://ga.jspm.io/npm:@mui/material",
  );
});

test("runtime-jspm keeps custom import map entries", () => {
  const loader = new JspmModuleLoader({
    importMap: {
      "app:chart": "https://cdn.example.com/chart.mjs",
    },
  });

  assert.equal(
    loader.resolveSpecifier("app:chart"),
    "https://cdn.example.com/chart.mjs",
  );
});

test("runtime-jspm resolves compatibility matrix sample packages", () => {
  const loader = new JspmModuleLoader();

  const matrix = [
    {
      specifier: "preact/hooks",
      expected:
        "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
    },
    {
      specifier: "lodash-es",
      expectedPrefix: "https://ga.jspm.io/npm:lodash-es",
    },
    {
      specifier: "date-fns",
      expectedPrefix: "https://ga.jspm.io/npm:date-fns",
    },
    {
      specifier: "@mui/material",
      expectedPrefix: "https://ga.jspm.io/npm:@mui/material",
    },
  ] as const;

  for (const entry of matrix) {
    const resolved = loader.resolveSpecifier(entry.specifier);
    if ("expected" in entry) {
      assert.equal(resolved, entry.expected);
      continue;
    }
    assert.ok(resolved.startsWith(entry.expectedPrefix));
  }
});

test("runtime-jspm rejects unsupported schemes and node builtins", () => {
  const loader = new JspmModuleLoader();

  assert.throws(
    () => loader.resolveSpecifier("node:fs"),
    /Node\.js builtin modules are not supported/,
  );
  assert.throws(
    () => loader.resolveSpecifier("fs"),
    /Node\.js builtin modules are not supported/,
  );
  assert.throws(
    () => loader.resolveSpecifier("child_process"),
    /Node\.js builtin modules are not supported/,
  );
  assert.throws(
    () => loader.resolveSpecifier("file:///tmp/demo.mjs"),
    /Unsupported module scheme/,
  );
  assert.throws(
    () => loader.resolveSpecifier("jsr:@std/assert"),
    /Unsupported module scheme/,
  );
});

test("runtime-jspm de-duplicates concurrent in-flight loads", async () => {
  const loader = new JspmModuleLoader();
  const globalState = globalThis as unknown as {
    System?: { import(url: string): Promise<unknown> };
  };
  const previousSystem = globalState.System;

  let importCalls = 0;
  let resolvePending: ((value: unknown) => void) | undefined;
  const pending = new Promise<unknown>((resolve) => {
    resolvePending = resolve;
  });

  globalState.System = {
    import: async (_url: string): Promise<unknown> => {
      importCalls += 1;
      return pending;
    },
  };

  try {
    const first = loader.load("lodash-es");
    const second = loader.load("lodash-es");

    await Promise.resolve();
    assert.equal(importCalls, 1);

    const moduleNamespace = { loaded: true };
    resolvePending?.(moduleNamespace);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult, moduleNamespace);
    assert.equal(secondResult, moduleNamespace);
    assert.equal(importCalls, 1);

    const cachedResult = await loader.load("lodash-es");
    assert.equal(cachedResult, moduleNamespace);
    assert.equal(importCalls, 1);
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }
  }
});

test("runtime-jspm materializes remote HTTP modules when System.import is unavailable", async () => {
  const loader = new JspmModuleLoader({
    importMap: {
      "app:entry": "https://cdn.example.com/entry.mjs",
    },
  });
  const globalState = globalThis as unknown as {
    System?: { import(url: string): Promise<unknown> };
    fetch?: typeof fetch;
  };
  const previousSystem = globalState.System;
  const previousFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  delete globalState.System;
  globalState.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    requestedUrls.push(requestUrl);

    if (requestUrl === "https://cdn.example.com/entry.mjs") {
      return new Response(
        'import { value } from "./dep.mjs"; export default value + 1;',
        {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
          },
        },
      );
    }

    if (requestUrl === "https://cdn.example.com/dep.mjs") {
      return new Response("export const value = 41;", {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    return new Response("not-found", { status: 404 });
  }) as typeof fetch;

  try {
    const loaded = (await loader.load("app:entry")) as { default: number };
    assert.equal(loaded.default, 42);
    assert.deepEqual(requestedUrls, [
      "https://cdn.example.com/entry.mjs",
      "https://cdn.example.com/dep.mjs",
    ]);
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }

    globalThis.fetch = previousFetch;
  }
});
