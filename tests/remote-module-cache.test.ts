import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRemoteModuleCache,
  getRemoteModuleCacheStats,
  isImmutableRemoteModuleUrl,
  loadSharedRemoteModule,
} from "../packages/runtime/src/remote-module-cache";

test("only version-pinned https module URLs are treated as immutable", () => {
  for (const url of [
    "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
    "https://esm.sh/preact@10.28.3/hooks?target=es2022",
    "https://esm.sh/preact@10.28.3?target=es2022",
    "https://esm.sh/@mui/material@7.3.4?bundle&deps=react@19.2.0",
    "https://esm.sh/v135/react-dom@19.2.0-rc.1/client",
  ]) {
    assert.equal(isImmutableRemoteModuleUrl(url), true, url);
  }
  for (const url of [
    "https://esm.sh/preact?target=es2022",
    "https://esm.sh/preact@latest",
    "https://esm.sh/preact@^10.28.3",
    "https://esm.sh/preact@10",
    "http://esm.sh/preact@10.28.3",
    "blob:https://app.example/1",
    "not a url",
  ]) {
    assert.equal(isImmutableRemoteModuleUrl(url), false, url);
  }
});

test("shared loads dedupe pinned URLs and retry failures", async () => {
  clearRemoteModuleCache();
  const url = "https://esm.sh/demo@1.0.0/index.mjs";
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { url, code: "export default 1;", contentType: "text/javascript" };
  };

  const [first, second] = await Promise.all([
    loadSharedRemoteModule(url, load),
    loadSharedRemoteModule(url, load),
  ]);
  assert.equal(first, second);
  await loadSharedRemoteModule(url, load);
  assert.equal(loads, 1);
  assert.equal(getRemoteModuleCacheStats().entries, 1);

  const failing = "https://esm.sh/flaky@2.0.0/index.mjs";
  let attempts = 0;
  await assert.rejects(
    loadSharedRemoteModule(failing, async () => {
      attempts += 1;
      throw new Error("network down");
    }),
    /network down/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await loadSharedRemoteModule(failing, async () => {
    attempts += 1;
    return { url: failing, code: "ok", contentType: "text/javascript" };
  });
  assert.equal(recovered.code, "ok");
  assert.equal(attempts, 2);

  // Ranges and tags are reused briefly; non-https URLs are never shared.
  const ranged = "https://esm.sh/demo@%5E1.0.0/index.mjs";
  const insecure = "http://cdn.example/demo@1.0.0/index.mjs";
  const counts = new Map<string, number>();
  for (const target of [ranged, ranged, insecure, insecure]) {
    await loadSharedRemoteModule(target, async () => {
      counts.set(target, (counts.get(target) ?? 0) + 1);
      return { url: target, code: "", contentType: "text/javascript" };
    });
  }
  assert.equal(counts.get(ranged), 1);
  assert.equal(counts.get(insecure), 2);

  clearRemoteModuleCache();
  assert.deepEqual(getRemoteModuleCacheStats(), { entries: 0, bytes: 0 });
});
