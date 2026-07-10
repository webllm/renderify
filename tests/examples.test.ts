import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BROWSER_RUNTIME_EXAMPLES = [
  "examples/runtime/browser-runtime-example.html",
  "examples/runtime/browser-tsx-jspm-example.html",
];

test("browser runtime examples use the published ESM build surface", async () => {
  for (const file of BROWSER_RUNTIME_EXAMPLES) {
    const html = await readFile(file, "utf8");

    assert.doesNotMatch(html, /core\.umd(?:\.min)?\.js/);
    assert.match(
      html,
      /import \* as RenderifyCore from "\.\.\/\.\.\/packages\/core\/dist\/core\.mjs"/,
    );
    assert.match(
      html,
      /"@renderify\/runtime": "\.\.\/\.\.\/packages\/runtime\/dist\/runtime\.mjs"/,
    );
    assert.match(html, /"preact\/hooks":/);
    assert.match(html, /"es-module-lexer":/);
  }
});
