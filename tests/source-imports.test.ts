import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRuntimeSourceImports,
  parseRuntimeSourceImportRanges,
} from "../packages/ir/src/source-imports";

test("source-imports parses static import forms", async () => {
  const source = [
    'import x from "pkg-a";',
    'import { y } from "pkg-b";',
    'import * as ns from "pkg-c";',
    'import "pkg-d";',
  ].join("\n");

  const imports = await collectRuntimeSourceImports(source);
  assert.deepEqual(imports.sort(), ["pkg-a", "pkg-b", "pkg-c", "pkg-d"]);
});

test("source-imports parses dynamic imports and re-exports", async () => {
  const source = [
    'export { a } from "pkg-export";',
    'const m = await import("pkg-dynamic");',
  ].join("\n");

  const imports = await collectRuntimeSourceImports(source);
  assert.deepEqual(imports.sort(), ["pkg-dynamic", "pkg-export"]);
});

test("source-imports handles multiline and scoped package imports", async () => {
  const source = [
    "import {",
    "  one,",
    "  two",
    '} from "@scope/pkg";',
    'const lazy = import("@scope/other");',
  ].join("\n");

  const imports = await collectRuntimeSourceImports(source);
  assert.deepEqual(imports.sort(), ["@scope/other", "@scope/pkg"]);
});

test("source-imports ignores commented and string-literal pseudo imports", async () => {
  const source = [
    '// import "commented";',
    'const text = "import(\\"not-real\\")";',
    '/* export { x } from "ignored" */',
    'import real from "real-pkg";',
  ].join("\n");

  const imports = await collectRuntimeSourceImports(source);
  assert.deepEqual(imports, ["real-pkg"]);
});

test("source-imports returns sorted ranges with start/end positions", async () => {
  const source = [
    'import a from "pkg-a";',
    'const b = await import("pkg-b");',
  ].join("\n");

  const ranges = await parseRuntimeSourceImportRanges(source);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].start < ranges[1].start);
  assert.ok(ranges[0].end > ranges[0].start);
  assert.equal(ranges[0].specifier, "pkg-a");
  assert.equal(ranges[1].specifier, "pkg-b");
});

test("source-imports returns empty list for empty source", async () => {
  const imports = await collectRuntimeSourceImports("   \n\t  ");
  assert.deepEqual(imports, []);
});
