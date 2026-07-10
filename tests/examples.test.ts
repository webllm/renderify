import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BROWSER_RUNTIME_EXAMPLES = [
  "examples/runtime/browser-runtime-example.html",
  "examples/runtime/browser-tsx-jspm-example.html",
];
const BABEL_EXAMPLES = [
  "examples/killer/hash-code-runner.html",
  "examples/killer/one-line-chat-dashboard.html",
  "examples/killer/one-line-chat-form.html",
  "examples/runtime/browser-tsx-jspm-example.html",
  "examples/todo/react-shadcn-todo-hash.html",
  "examples/todo/react-shadcn-todo.html",
];
const BABEL_STANDALONE_URL =
  "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js";
const BABEL_STANDALONE_INTEGRITY =
  "sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y";

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

test("browser examples pin and authenticate Babel standalone", async () => {
  for (const file of BABEL_EXAMPLES) {
    const html = await readFile(file, "utf8");
    const babelScript = html.match(
      /<script\s+[^>]*src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"[^>]*><\/script>/,
    )?.[0];

    assert.ok(babelScript, `${file} must load Babel standalone`);
    assert.match(babelScript, new RegExp(`src="${BABEL_STANDALONE_URL}"`));
    assert.match(
      babelScript,
      new RegExp(`integrity="${BABEL_STANDALONE_INTEGRITY}"`),
    );
    assert.match(babelScript, /crossorigin="anonymous"/);
  }
});
