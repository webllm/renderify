import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const REPO_ROOT = process.cwd();
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const RENDERIFY_CLI_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "cli",
  "src",
  "index.ts",
);

async function runCli(args: string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, RENDERIFY_CLI_ENTRY, ...args],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: "pipe",
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

test("cli shows help text", async () => {
  const result = await runCli(["help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /renderify playground \[port\]/);
});

test("cli accepts leading -- separator", async () => {
  const result = await runCli(["--", "help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
});

test("cli validates playground port argument", async () => {
  const result = await runCli(["playground", "abc"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid port: abc/);
});

test("cli validates unknown playground option", async () => {
  const result = await runCli(["playground", "--trace"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown playground option: --trace/);
});

test("cli requires plan file for probe-plan", async () => {
  const result = await runCli(["probe-plan"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /probe-plan requires a JSON file path/);
});

test("cli requires plan file for render-plan", async () => {
  const result = await runCli(["render-plan"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /render-plan requires a JSON file path/);
});
