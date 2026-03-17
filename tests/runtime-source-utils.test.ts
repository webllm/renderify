import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserBlobModuleUrl } from "../packages/runtime/src/runtime-source-utils";

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
