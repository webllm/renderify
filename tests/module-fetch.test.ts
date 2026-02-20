import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteModuleAttemptUrls,
  createCssProxyModuleSource,
  createJsonProxyModuleSource,
  createTextProxyModuleSource,
  createUrlProxyModuleSource,
  extractJspmNpmSpecifier,
  fetchWithTimeout,
  isCssModuleResponse,
  isJavaScriptModuleResponse,
  isJsonModuleResponse,
  isLikelyUnpinnedJspmNpmUrl,
  type RemoteModuleFetchResult,
  toConfiguredFallbackUrl,
  toEsmFallbackUrl,
} from "../packages/runtime/src/module-fetch";

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "fetch");

  Object.defineProperty(root, "fetch", {
    configurable: true,
    writable: true,
    value: impl,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(root, "fetch", descriptor);
    } else {
      delete root.fetch;
    }
  };
}

function fetched(
  overrides: Partial<RemoteModuleFetchResult>,
): RemoteModuleFetchResult {
  return {
    url: "https://ga.jspm.io/npm:nanoid@5/index.js",
    code: "export default 1;",
    contentType: "application/javascript",
    requestUrl: "https://ga.jspm.io/npm:nanoid@5/index.js",
    ...overrides,
  };
}

test("module-fetch extracts jspm npm specifiers", () => {
  assert.equal(
    extractJspmNpmSpecifier(
      "https://ga.jspm.io/npm:@mui/material@7.3.5/index.js",
    ),
    "@mui/material@7.3.5/index.js",
  );
  assert.equal(
    extractJspmNpmSpecifier(
      "https://example.com/npm:@mui/material@7.3.5/index.js",
    ),
    undefined,
  );
  assert.equal(
    extractJspmNpmSpecifier(
      "https://cdn.jspm.io/npm:@mui/material@7.3.5/index.js?dev",
    ),
    "@mui/material@7.3.5/index.js?dev",
  );
});

test("module-fetch detects unpinned jspm npm endpoint urls", () => {
  assert.equal(
    isLikelyUnpinnedJspmNpmUrl("https://ga.jspm.io/npm:@mui/material"),
    true,
  );
  assert.equal(
    isLikelyUnpinnedJspmNpmUrl(
      "https://ga.jspm.io/npm:@mui/material@7.3.5/esm/index.js",
    ),
    false,
  );
  assert.equal(
    isLikelyUnpinnedJspmNpmUrl("https://example.com/npm:@mui/material"),
    false,
  );
});

test("module-fetch generates esm.sh/jsdelivr/unpkg/jspm fallback urls", () => {
  const source = "https://ga.jspm.io/npm:@mui/material@7.3.5/index.js";

  const esm = toEsmFallbackUrl(source);
  assert.equal(typeof esm, "string");
  assert.match(
    String(esm),
    /^https:\/\/esm\.sh\/@mui\/material@7\.3\.5\/index\.js\?/,
  );
  assert.match(String(esm), /alias=react:preact\/compat/);

  const jsdelivr = toConfiguredFallbackUrl(source, "https://cdn.jsdelivr.net");
  assert.equal(
    jsdelivr,
    "https://cdn.jsdelivr.net/npm/@mui/material@7.3.5/index.js",
  );

  const unpkg = toConfiguredFallbackUrl(source, "https://unpkg.com");
  assert.equal(unpkg, "https://unpkg.com/@mui/material@7.3.5/index.js?module");

  const jspm = toConfiguredFallbackUrl(source, "https://cdn.jspm.io/npm");
  assert.equal(jspm, "https://cdn.jspm.io/npm:@mui/material@7.3.5/index.js");
});

test("module-fetch builds deduplicated fallback attempt list", () => {
  const source = "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js";
  const attempts = buildRemoteModuleAttemptUrls(source, [
    "https://esm.sh",
    "https://esm.sh",
    "https://cdn.jsdelivr.net",
  ]);

  assert.equal(attempts[0], source);
  assert.ok(attempts.length >= 2);
  assert.equal(new Set(attempts).size, attempts.length);
});

test("module-fetch detects css/json/js module responses", () => {
  assert.equal(
    isCssModuleResponse(
      fetched({
        url: "https://ga.jspm.io/npm:demo@1/styles.css",
        contentType: "text/css",
      }),
    ),
    true,
  );

  assert.equal(
    isJsonModuleResponse(
      fetched({
        url: "https://ga.jspm.io/npm:demo@1/data.json",
        contentType: "application/json",
      }),
    ),
    true,
  );

  assert.equal(
    isJavaScriptModuleResponse(
      fetched({
        url: "https://ga.jspm.io/npm:demo@1/index.mjs",
        contentType: "application/javascript",
      }),
    ),
    true,
  );
});

test("module-fetch builds proxy module source templates", () => {
  const cssProxy = createCssProxyModuleSource(
    "body{color:red}",
    "https://x/a.css",
  );
  assert.match(cssProxy, /data-renderify-style-id/);
  assert.match(cssProxy, /export default __css;/);

  const jsonProxy = createJsonProxyModuleSource({ ok: true });
  assert.match(jsonProxy, /const __json = {"ok":true};/);

  const textProxy = createTextProxyModuleSource("hello");
  assert.match(textProxy, /export const text = __text;/);

  const urlProxy = createUrlProxyModuleSource("https://cdn.test/a.wasm");
  assert.match(urlProxy, /export const assetUrl = __assetUrl;/);
});

test("module-fetch fetchWithTimeout passes AbortSignal and resolves response", async () => {
  let sawSignal = false;

  const restoreFetch = installMockFetch(async (_input, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Response("ok", { status: 200 });
  });

  try {
    const response = await fetchWithTimeout("https://x.test", 100);
    assert.equal(response.status, 200);
    assert.equal(sawSignal, true);
  } finally {
    restoreFetch();
  }
});

test("module-fetch fetchWithTimeout aborts long-running request", async () => {
  const restoreFetch = installMockFetch(async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  });

  try {
    await assert.rejects(
      () => fetchWithTimeout("https://x.test", 10),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    restoreFetch();
  }
});
