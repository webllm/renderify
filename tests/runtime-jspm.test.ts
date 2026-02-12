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
