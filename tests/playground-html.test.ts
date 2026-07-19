import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlaygroundHtml,
  PLAYGROUND_HTML,
} from "../packages/cli/src/playground-html";

test("playground never rebuilds runtime source as a browser Blob module", () => {
  assert.doesNotMatch(PLAYGROUND_HTML, /\bURL\.createObjectURL\s*\(/);
  assert.doesNotMatch(PLAYGROUND_HTML, /\bnew\s+Blob\s*\(/);
  assert.doesNotMatch(PLAYGROUND_HTML, /\bimport\s*\(/);
  assert.doesNotMatch(PLAYGROUND_HTML, /@babel\/standalone/);
});

test("playground iframe output explicitly blocks scripts", () => {
  assert.match(
    PLAYGROUND_HTML,
    /setAttribute\(\s*"sandbox"\s*,\s*"allow-same-origin"\s*\)/,
  );
  assert.doesNotMatch(
    PLAYGROUND_HTML,
    /setAttribute\(\s*"sandbox"\s*,\s*"[^"]*allow-scripts/,
  );
});

test("playground does not replace server output with prompt-specific UI", () => {
  assert.doesNotMatch(PLAYGROUND_HTML, /PLAYGROUND_TODO_FALLBACK/);
  assert.doesNotMatch(PLAYGROUND_HTML, /mountBuiltinTodoFallback/);
  assert.doesNotMatch(PLAYGROUND_HTML, /interactive todo fallback/i);
});

test("playground only loads the browser runtime when source execution is enabled", () => {
  const disabled = createPlaygroundHtml();
  const enabled = createPlaygroundHtml({
    browserRuntime: {
      enabled: true,
      config: {
        securityInitialization: { profile: "trusted" },
      },
    },
  });

  assert.doesNotMatch(disabled, /src="\/playground-runtime\.js"/);
  assert.match(enabled, /src="\/playground-runtime\.js"/);
  assert.match(enabled, /"enabled":true/);
  assert.match(enabled, /"profile":"trusted"/);
  assert.doesNotMatch(enabled, /__RENDERIFY_PLAYGROUND_RUNTIME_/);
});

test("playground awaits browser mounting before reporting a final render", () => {
  assert.match(PLAYGROUND_HTML, /const applyRenderPayload = async/);
  assert.match(PLAYGROUND_HTML, /await browserRuntimeClient\.mount/);
  assert.match(PLAYGROUND_HTML, /await applyRenderPayload\(payload\)/);
  assert.match(PLAYGROUND_HTML, /PLAYGROUND_BROWSER_MOUNT_FAILED/);
});
