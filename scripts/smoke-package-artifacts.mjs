#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const libraryPackages = [
  "ir",
  "security",
  "runtime",
  "core",
  "llm",
  "renderify",
];

for (const name of libraryPackages) {
  const distDirectory = path.join(root, "packages", name, "dist");
  const esmPath = path.join(distDirectory, `${name}.mjs`);
  const cjsPath = path.join(distDirectory, `${name}.cjs`);

  const esmNamespace = await import(pathToFileURL(esmPath).href);
  assert.ok(
    Object.keys(esmNamespace).length > 0,
    `${name} ESM artifact has no exports`,
  );

  const cjsNamespace = require(cjsPath);
  assert.ok(
    cjsNamespace && Object.keys(cjsNamespace).length > 0,
    `${name} CommonJS artifact has no exports`,
  );
}

for (const relativePath of [
  "packages/cli/dist/cli.mjs",
  "packages/cli/dist/cli.cjs",
  "packages/cli/bin/renderify.js",
]) {
  execFileSync(process.execPath, ["--check", path.join(root, relativePath)], {
    stdio: "pipe",
  });
}

console.log("Package artifact smoke checks passed.");
