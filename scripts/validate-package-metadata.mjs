#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PACKAGE_DIR = "packages";
const REQUIRED_PACKAGES = [
  "cli",
  "core",
  "ir",
  "llm",
  "renderify",
  "runtime",
  "security",
];

const failures = [];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    failures.push(
      `${filePath}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    failures.push(`${message}: expected "${expected}", got "${actual}"`);
  }
}

for (const name of REQUIRED_PACKAGES) {
  const pkgPath = path.join(PACKAGE_DIR, name, "package.json");
  if (!fs.existsSync(pkgPath)) {
    failures.push(`${pkgPath}: package.json not found`);
    continue;
  }

  const pkg = readJson(pkgPath);
  if (!pkg) continue;

  if (Object.hasOwn(pkg, "preconstruct")) {
    failures.push(
      `${pkgPath}: preconstruct field must be removed after tsup migration`,
    );
  }

  expectEqual(pkg.main, `dist/${name}.cjs.js`, `${pkgPath} main`);
  expectEqual(pkg.module, `dist/${name}.esm.js`, `${pkgPath} module`);
  expectEqual(pkg.types, `dist/${name}.d.ts`, `${pkgPath} types`);

  const rootExport = pkg.exports?.["."];
  if (!rootExport || typeof rootExport !== "object") {
    failures.push(`${pkgPath}: exports["."] must be configured`);
    continue;
  }

  expectEqual(
    rootExport.types,
    `./dist/${name}.d.ts`,
    `${pkgPath} exports["."].types`,
  );
  expectEqual(
    rootExport.import,
    `./dist/${name}.esm.js`,
    `${pkgPath} exports["."].import`,
  );
  expectEqual(
    rootExport.require,
    `./dist/${name}.cjs.js`,
    `${pkgPath} exports["."].require`,
  );

  if (pkg.scripts?.["build:repo"] !== "tsup --config tsup.config.ts") {
    failures.push(
      `${pkgPath}: scripts["build:repo"] must be "tsup --config tsup.config.ts"`,
    );
  }
}

if (failures.length > 0) {
  console.error("Package metadata validation failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Package metadata validation passed.");
