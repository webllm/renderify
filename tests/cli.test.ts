import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

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

async function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const env = {
      ...process.env,
      ...envOverrides,
    };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) {
        delete env[key];
      }
    }

    const child = spawn(
      process.execPath,
      [TSX_CLI, RENDERIFY_CLI_ENTRY, ...args],
      {
        cwd: REPO_ROOT,
        env,
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
  assert.match(
    result.stdout,
    /renderify playground \[port\] \[--host <host>\]/,
  );
  assert.match(result.stdout, /renderify auth codex login\|status\|logout/);
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

test("cli requires a value for the playground host option", async () => {
  const result = await runCli(["playground", "--host"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Playground option --host requires a host value/);
});

test("cli rejects an empty inline playground host", async () => {
  const result = await runCli(["playground", "--host="]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Playground host cannot be empty/);
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

test("cli reports missing codex auth status", async (t) => {
  const authFile = await tempAuthFile(t);
  const result = await runCli(["auth", "codex", "status"], {
    RENDERIFY_CODEX_AUTH_FILE: authFile,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /OpenAI Codex: not logged in/);
  assert.match(result.stdout, new RegExp(escapeRegExp(authFile)));
  assert.match(result.stdout, /No OpenAI Codex credentials stored/);
});

test("cli handles codex logout without stored credentials", async (t) => {
  const authFile = await tempAuthFile(t);
  const result = await runCli(["auth", "codex", "logout"], {
    RENDERIFY_CODEX_AUTH_FILE: authFile,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No OpenAI Codex credentials were stored/);
});

test("cli validates unknown codex auth action", async () => {
  const result = await runCli(["auth", "codex", "refresh"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown Codex auth action: refresh/);
});

async function tempAuthFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "renderify-cli-auth-"));
  t.after(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
    });
  });
  return path.join(dir, "auth.json");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
