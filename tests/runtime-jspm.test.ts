import assert from "node:assert/strict";
import test from "node:test";
import { JspmModuleLoader } from "../packages/runtime/src/index";

function createRemoteModuleResponse(input: {
  url: string;
  body?: string;
  onRead?: () => void;
}): Response {
  return {
    ok: true,
    status: 200,
    url: input.url,
    headers: new Headers({
      "content-type": "text/javascript; charset=utf-8",
    }),
    text: async () => {
      input.onRead?.();
      return input.body ?? "export default 1;";
    },
  } as Response;
}

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

test("runtime-jspm evicts stale module cache entries beyond capacity", async () => {
  const loader = new JspmModuleLoader({
    moduleCacheMaxEntries: 2,
  });
  const globalState = globalThis as unknown as {
    System?: { import(url: string): Promise<unknown> };
  };
  const previousSystem = globalState.System;

  globalState.System = {
    import: async (url: string): Promise<unknown> => ({ url }),
  };

  try {
    await loader.load("lodash-es");
    await loader.load("date-fns");
    await loader.load("nanoid");

    const cache = (
      loader as unknown as {
        cache: Map<string, unknown>;
      }
    ).cache;
    assert.equal(cache.size, 2);
    assert.equal(
      [...cache.keys()].some((key) => key.includes("lodash-es")),
      false,
    );
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }
  }
});

test("runtime-jspm enforces configured policy after redirects before native import", async () => {
  const loader = new JspmModuleLoader({
    remoteFallbackCdnBases: ["https://cdn.example.com"],
    remoteFetchRetries: 0,
  });
  loader.configureNetworkPolicy({
    allowArbitraryNetwork: false,
    isRemoteUrlAllowed: (url) => new URL(url).hostname === "cdn.example.com",
  });

  const globalState = globalThis as unknown as {
    System?: { import(url: string): Promise<unknown> };
  };
  const previousSystem = globalState.System;
  const previousFetch = globalThis.fetch;
  let systemImportCalls = 0;
  let responseReads = 0;

  globalState.System = {
    import: async () => {
      systemImportCalls += 1;
      return { default: "native import bypass" };
    },
  };
  globalThis.fetch = (async () =>
    createRemoteModuleResponse({
      url: "https://evil.example.com/entry.mjs",
      onRead: () => {
        responseReads += 1;
      },
    })) as typeof fetch;

  try {
    await assert.rejects(
      loader.load("https://cdn.example.com/entry.mjs"),
      /response URL is blocked by runtime network policy/,
    );
    assert.equal(responseReads, 0);
    assert.equal(systemImportCalls, 0);
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }
    globalThis.fetch = previousFetch;
  }
});

test("runtime-jspm applies configured policy to transitive imports", async () => {
  const loader = new JspmModuleLoader({
    remoteFallbackCdnBases: ["https://cdn.example.com"],
    remoteFetchRetries: 0,
  });
  loader.configureNetworkPolicy({
    allowArbitraryNetwork: false,
    isRemoteUrlAllowed: (url) => new URL(url).hostname === "cdn.example.com",
  });

  const previousFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    requestedUrls.push(requestUrl);
    return createRemoteModuleResponse({
      url: requestUrl,
      body: 'import "https://evil.example.com/dep.mjs"; export default 1;',
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      loader.load("https://cdn.example.com/entry.mjs"),
      /blocked by runtime network policy/,
    );
    assert.deepEqual(requestedUrls, ["https://cdn.example.com/entry.mjs"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("runtime-jspm invalidates materialized modules when policy changes", async () => {
  const loader = new JspmModuleLoader({
    remoteFallbackCdnBases: ["https://cdn.example.com"],
    remoteFetchRetries: 0,
  });
  const remoteUrl = "https://cdn.example.com/cache-policy.mjs";
  const globalState = globalThis as unknown as {
    System?: { import(url: string): Promise<unknown> };
  };
  const previousSystem = globalState.System;
  const previousFetch = globalThis.fetch;
  let systemImportCalls = 0;
  let fetchCalls = 0;

  globalState.System = {
    import: async () => {
      systemImportCalls += 1;
      return { default: "unrestricted" };
    },
  };

  try {
    const unrestricted = (await loader.load(remoteUrl)) as { default: string };
    assert.equal(unrestricted.default, "unrestricted");

    loader.configureNetworkPolicy({
      allowArbitraryNetwork: false,
      isRemoteUrlAllowed: (url) => new URL(url).hostname === "cdn.example.com",
    });
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return createRemoteModuleResponse({
        url: remoteUrl,
        body: 'export default "restricted";',
      });
    }) as typeof fetch;

    const restricted = (await loader.load(remoteUrl)) as { default: string };
    assert.equal(restricted.default, "restricted");
    assert.equal(systemImportCalls, 1);
    assert.equal(fetchCalls, 1);
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }
    globalThis.fetch = previousFetch;
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

test("runtime-jspm falls back from unpinned jspm endpoints to esm.sh", async () => {
  const loader = new JspmModuleLoader({
    remoteFallbackCdnBases: ["https://esm.sh"],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 1200,
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

    if (requestUrl === "https://ga.jspm.io/npm:nanoid") {
      return new Response("5.1.6", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (requestUrl.startsWith("https://esm.sh/nanoid")) {
      return new Response("export default 7;", {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    return new Response("not-found", { status: 404 });
  }) as typeof fetch;

  try {
    const loaded = (await loader.load("nanoid")) as { default: number };
    assert.equal(loaded.default, 7);
    assert.ok(
      requestedUrls.includes("https://ga.jspm.io/npm:nanoid"),
      "expected unpinned jspm endpoint to be attempted first",
    );
    assert.ok(
      requestedUrls.some((url) => url.startsWith("https://esm.sh/nanoid")),
      "expected esm.sh fallback to be attempted",
    );
  } finally {
    if (previousSystem === undefined) {
      delete globalState.System;
    } else {
      globalState.System = previousSystem;
    }

    globalThis.fetch = previousFetch;
  }
});
