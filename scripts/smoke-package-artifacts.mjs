#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function readTarString(header, offset, length) {
  const value = header.subarray(offset, offset + length).toString("utf8");
  const nullIndex = value.indexOf("\0");
  return (nullIndex === -1 ? value : value.slice(0, nullIndex)).trim();
}

function readTarEntry(tarballPath, entryName) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarballPath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarString(header, 124, 12), 8);
    assert.ok(Number.isFinite(size), `Invalid tar entry size for ${fullName}`);

    const dataStart = offset + 512;
    if (fullName === entryName) {
      return archive.subarray(dataStart, dataStart + size).toString("utf8");
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  assert.fail(`${entryName} is missing from ${tarballPath}`);
}

const libraryPackages = [
  "ir",
  "security",
  "runtime",
  "core",
  "llm",
  "mcp-app",
  "frame",
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
  "packages/mcp-app/dist/view.mjs",
  "packages/mcp-app/dist/view.cjs",
]) {
  const namespace = relativePath.endsWith(".mjs")
    ? await import(pathToFileURL(path.join(root, relativePath)).href)
    : require(path.join(root, relativePath));
  assert.equal(
    typeof namespace.startRenderifyMcpApp,
    "function",
    `${relativePath} is missing startRenderifyMcpApp`,
  );
}

const mcpAppEsm = await import(
  pathToFileURL(path.join(root, "packages/mcp-app/dist/mcp-app.mjs")).href
);
const mcpAppCjs = require(path.join(root, "packages/mcp-app/dist/mcp-app.cjs"));
for (const [format, namespace] of [
  ["ESM", mcpAppEsm],
  ["CommonJS", mcpAppCjs],
]) {
  const shell = await namespace.createRenderifyShell();
  assert.match(shell.html, /Content-Security-Policy/);
  assert.equal(shell.csp.includes("unsafe-eval"), false);
  assert.equal(
    shell.csp.includes("script-src 'unsafe-inline'"),
    false,
    `${format} MCP App shell uses script unsafe-inline`,
  );
}

// The frame host API pins the runner it ships with by SRI hash.
const frameDirectory = path.join(root, "packages/frame");
for (const runner of ["runner.js", "runner-plan.js"]) {
  const runnerIntegrity = `sha384-${createHash("sha384")
    .update(fs.readFileSync(path.join(frameDirectory, "dist", runner)))
    .digest("base64")}`;
  for (const artifact of ["dist/frame.mjs", "dist/frame.cjs"]) {
    assert.ok(
      fs
        .readFileSync(path.join(frameDirectory, artifact), "utf8")
        .includes(runnerIntegrity),
      `${artifact} does not pin the ${runner} integrity ${runnerIntegrity}`,
    );
  }
}
const frameEsm = await import(
  pathToFileURL(path.join(frameDirectory, "dist/frame.mjs")).href
);
assert.equal(typeof frameEsm.createRenderifyFrame, "function");
assert.match(
  frameEsm.DEFAULT_RENDERIFY_FRAME_RUNNER_URL,
  new RegExp(
    `@renderify/frame@${JSON.parse(fs.readFileSync(path.join(frameDirectory, "package.json"), "utf8")).version}/dist/runner\\.js$`,
  ),
);
assert.doesNotMatch(
  fs.readFileSync(path.join(frameDirectory, "README.md"), "utf8"),
  /\]\(\/docs\//,
  "@renderify/frame README contains repository-root links that break on npm",
);
assert.equal(
  fs.readFileSync(path.join(frameDirectory, "LICENSE"), "utf8"),
  fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  "@renderify/frame LICENSE differs from the repository license",
);

// MCP source mode inlines the installed frame runner and allows it by hash.
const sourceModeRunner = fs.readFileSync(
  path.join(frameDirectory, "dist/runner.js"),
  "utf8",
);
const sourceModeRunnerHash = createHash("sha256")
  .update(sourceModeRunner, "utf8")
  .digest("base64");
for (const [format, namespace] of [
  ["ESM", mcpAppEsm],
  ["CommonJS", mcpAppCjs],
]) {
  const shell = await namespace.createRenderifyShell({ sourceMode: true });
  assert.ok(
    shell.html.includes(
      `<script type="text/plain" id="renderify-frame-runner">${sourceModeRunner}</script>`,
    ),
    `${format} MCP App source-mode shell does not inline the frame runner`,
  );
  assert.ok(
    shell.csp.includes(`'sha256-${sourceModeRunnerHash}'`),
    `${format} MCP App source-mode CSP does not allow the frame runner`,
  );
  assert.equal(shell.csp.includes("unsafe-eval"), false);
}

const mcpAppDirectory = path.join(root, "packages/mcp-app");
const mcpAppPackage = JSON.parse(
  fs.readFileSync(path.join(mcpAppDirectory, "package.json"), "utf8"),
);
assert.doesNotMatch(
  fs.readFileSync(path.join(mcpAppDirectory, "README.md"), "utf8"),
  /\]\(\/docs\//,
  "@renderify/mcp-app README contains repository-root links that break on npm",
);
assert.equal(
  fs.readFileSync(path.join(mcpAppDirectory, "LICENSE"), "utf8"),
  fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  "@renderify/mcp-app LICENSE differs from the repository license",
);
assert.equal(
  mcpAppPackage.scripts?.prepublishOnly,
  "node ../../scripts/ensure-pnpm.js",
  "@renderify/mcp-app must reject direct npm publishing",
);

const packDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "renderify-mcp-app-pack-"),
);
try {
  const tarballPath = path.join(packDirectory, "mcp-app.tgz");
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  execFileSync(pnpmCommand, ["pack", "--out", tarballPath], {
    cwd: mcpAppDirectory,
    stdio: "pipe",
  });

  const packedPackage = JSON.parse(
    readTarEntry(tarballPath, "package/package.json"),
  );
  assert.equal(packedPackage.version, mcpAppPackage.version);
  assert.doesNotMatch(
    JSON.stringify(packedPackage),
    /workspace:/,
    "@renderify/mcp-app packed manifest leaks a workspace protocol",
  );

  for (const [dependency, packageDirectory] of [
    ["@renderify/ir", "ir"],
    ["@renderify/runtime", "runtime"],
    ["@renderify/security", "security"],
  ]) {
    const workspacePackage = JSON.parse(
      fs.readFileSync(
        path.join(root, "packages", packageDirectory, "package.json"),
        "utf8",
      ),
    );
    assert.equal(mcpAppPackage.dependencies?.[dependency], "workspace:^");
    assert.equal(
      packedPackage.dependencies?.[dependency],
      `^${workspacePackage.version}`,
      `${dependency} was not converted to its workspace semver range`,
    );
  }

  assert.equal(
    readTarEntry(tarballPath, "package/LICENSE"),
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
    "@renderify/mcp-app package tarball is missing the repository LICENSE",
  );
} finally {
  fs.rmSync(packDirectory, { recursive: true, force: true });
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
