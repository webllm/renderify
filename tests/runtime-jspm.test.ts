import assert from "node:assert/strict";
import test from "node:test";
import { JspmModuleLoader } from "../packages/runtime-jspm/src/index";

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
    "https://ga.jspm.io/npm:react@19.2.0/index.js",
  );
  assert.equal(
    loader.resolveSpecifier("npm:react-dom/client"),
    "https://ga.jspm.io/npm:react-dom@19.2.0/client.js",
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
