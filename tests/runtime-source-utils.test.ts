import assert from "node:assert/strict";
import test from "node:test";
import {
  createBrowserBlobModuleUrl,
  rewriteImportsAsync,
} from "../packages/runtime/src/runtime-source-utils";

test("rewriteImportsAsync resolves independent imports concurrently", async () => {
  const pendingResolvers = new Map<string, () => void>();
  const started: string[] = [];
  let resolveBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => {
    resolveBothStarted = resolve;
  });
  const rewriting = rewriteImportsAsync(
    [
      'import first from "first";',
      'import second from "second";',
      "export default [first, second];",
    ].join("\n"),
    (specifier) =>
      new Promise<string>((resolve) => {
        started.push(specifier);
        pendingResolvers.set(specifier, () =>
          resolve(`/resolved/${specifier}`),
        );
        if (started.length === 2) {
          resolveBothStarted?.();
        }
      }),
  );

  await Promise.race([
    bothStarted,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("imports resolved sequentially")), 250);
    }),
  ]);
  assert.deepEqual(started, ["first", "second"]);

  pendingResolvers.get("second")?.();
  pendingResolvers.get("first")?.();
  assert.equal(
    await rewriting,
    [
      'import first from "/resolved/first";',
      'import second from "/resolved/second";',
      "export default [first, second];",
    ].join("\n"),
  );
});

test("createBrowserBlobModuleUrl reuses cached urls for identical code", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  let createdCount = 0;

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (_blob: Blob) => `blob:renderify-${++createdCount}`,
  });

  try {
    const browserBlobUrls = new Set<string>();
    const browserBlobUrlsByCode = new Map<string, string>();

    const first = createBrowserBlobModuleUrl(
      "export default 1;",
      browserBlobUrls,
      browserBlobUrlsByCode,
    );
    const second = createBrowserBlobModuleUrl(
      "export default 1;",
      browserBlobUrls,
      browserBlobUrlsByCode,
    );

    assert.equal(first, second);
    assert.equal(createdCount, 1);
    assert.deepEqual([...browserBlobUrls], [first]);
  } finally {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
  }
});
