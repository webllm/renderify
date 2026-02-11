import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HistoryResponseBody {
  security?: {
    profile?: string;
  };
  tenantGovernor?: {
    policy?: {
      maxExecutionsPerMinute?: number;
    };
  };
  audits?: Array<{
    status?: string;
  }>;
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

test("e2e: cli persisted runtime flow (render-plan -> event -> state -> history)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "renderify-e2e-cli-"));
  const sessionFile = path.join(tempDir, "session.json");
  const env = {
    RENDERIFY_SESSION_FILE: sessionFile,
  };

  try {
    {
      const result = await runCli(["clear-history"], env);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /history cleared/);
    }

    {
      const result = await runCli(
        ["render-plan", "examples/runtime/counter-plan.json"],
        env,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Count: 0/);
    }

    {
      const result = await runCli(
        ["event", "example_counter_plan", "increment", '{"delta":1}'],
        env,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Count: 1/);
      assert.match(result.stdout, /History: \[1\]/);
    }

    {
      const result = await runCli(["state", "example_counter_plan"], env);
      assert.equal(result.code, 0, result.stderr);
      const state = JSON.parse(result.stdout.trim()) as {
        count: number;
        history: number[];
      };
      assert.equal(state.count, 1);
      assert.deepEqual(state.history, [1]);
    }

    {
      const result = await runCli(["history"], env);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /\[plans\]/);
      assert.match(result.stdout, /example_counter_plan/);
      assert.match(result.stdout, /mode=event/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli rejects invalid runtime plan file", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-invalid-plan-"),
  );
  const sessionFile = path.join(tempDir, "session.json");
  const invalidPlanPath = path.join(tempDir, "bad-plan.json");

  try {
    await writeFile(invalidPlanPath, '{"id":"bad"}', "utf8");

    const result = await runCli(["render-plan", invalidPlanPath], {
      RENDERIFY_SESSION_FILE: sessionFile,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Invalid RuntimePlan JSON/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli render-plan executes runtime source module", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-source-plan-"),
  );
  const sessionFile = path.join(tempDir, "session.json");
  const sourcePlanPath = path.join(tempDir, "source-plan.json");

  try {
    const sourcePlan = {
      specVersion: "runtime-plan/v1",
      id: "source_render_plan",
      version: 1,
      capabilities: {
        domWrite: true,
      },
      root: {
        type: "element",
        tag: "section",
        children: [
          {
            type: "text",
            value: "fallback root",
          },
        ],
      },
      source: {
        language: "js",
        code: [
          "export default () => ({",
          '  type: "element",',
          '  tag: "section",',
          "  children: [{ type: 'text', value: 'runtime source works' }],",
          "});",
        ].join("\n"),
      },
    };

    await writeFile(
      sourcePlanPath,
      JSON.stringify(sourcePlan, null, 2),
      "utf8",
    );

    const result = await runCli(["render-plan", sourcePlanPath], {
      RENDERIFY_SESSION_FILE: sessionFile,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /runtime source works/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli uses openai provider when configured", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-openai-"),
  );
  const sessionFile = path.join(tempDir, "session.json");
  const port = await allocatePort();
  const { requests, close } = await startFakeOpenAIServer(port);

  try {
    const result = await runCli(["plan", "runtime from openai provider"], {
      RENDERIFY_SESSION_FILE: sessionFile,
      RENDERIFY_LLM_PROVIDER: "openai",
      RENDERIFY_LLM_API_KEY: "test-key",
      RENDERIFY_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      RENDERIFY_LLM_MODEL: "gpt-4.1-mini",
    });

    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout.trim()) as {
      id: string;
      version: number;
      root: {
        type: string;
      };
    };

    assert.equal(plan.id, "fake_openai_plan");
    assert.equal(plan.version, 1);
    assert.equal(plan.root.type, "element");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "gpt-4.1-mini");

    const responseFormat = requests[0].response_format as {
      type?: string;
      json_schema?: {
        name?: string;
      };
    };
    assert.equal(responseFormat.type, "json_schema");
    assert.equal(responseFormat.json_schema?.name, "runtime_plan");
  } finally {
    await close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: playground api flow enforces tenant quota in process", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-playground-"),
  );
  const sessionFile = path.join(tempDir, "session.json");
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const processHandle = startPlayground(port, {
    RENDERIFY_SESSION_FILE: sessionFile,
    RENDERIFY_MAX_EXECUTIONS_PER_MINUTE: "1",
    RENDERIFY_MAX_CONCURRENT_EXECUTIONS: "1",
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`, 10000);

    const first = await fetchJson(`${baseUrl}/api/prompt`, {
      method: "POST",
      body: {
        prompt: "e2e playground first",
      },
    });
    const firstBody = first.body as { traceId?: unknown };
    assert.equal(first.status, 200);
    assert.equal(typeof firstBody.traceId, "string");

    const second = await fetchJson(`${baseUrl}/api/prompt`, {
      method: "POST",
      body: {
        prompt: "e2e playground second",
      },
    });
    const secondBody = second.body as { error?: unknown };
    assert.equal(second.status, 500);
    assert.match(
      String(secondBody.error ?? ""),
      /exceeded max executions per minute/,
    );

    const history = await fetchJson(`${baseUrl}/api/history`, {
      method: "GET",
    });
    const historyBody = history.body as HistoryResponseBody;
    assert.equal(history.status, 200);
    assert.equal(historyBody.security?.profile, "balanced");
    assert.equal(historyBody.tenantGovernor?.policy?.maxExecutionsPerMinute, 1);
    assert.ok(
      Array.isArray(historyBody.audits) &&
        historyBody.audits.some((audit) => audit.status === "throttled"),
    );
  } finally {
    processHandle.kill("SIGTERM");
    await onceExit(processHandle, 3000);
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function runCli(
  args: string[],
  envOverrides: Record<string, string>,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, RENDERIFY_CLI_ENTRY, ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...envOverrides,
        },
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

function startPlayground(
  port: number,
  envOverrides: Record<string, string>,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [TSX_CLI, RENDERIFY_CLI_ENTRY, "playground", String(port)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: "pipe",
    },
  );
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`playground health check timed out: ${url}`);
    }

    await sleep(120);
  }
}

async function fetchJson(
  url: string,
  input: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  },
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: input.method,
    headers: {
      "content-type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  const body = (await response.json()) as unknown;
  return {
    status: response.status,
    body,
  };
}

async function startFakeOpenAIServer(port: number): Promise<{
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const plan = {
    id: "fake_openai_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [
        {
          type: "text",
          value: "OpenAI provider plan",
        },
      ],
    },
  };

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      void (async () => {
        const method = (req.method ?? "GET").toUpperCase();
        const pathName = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

        if (method !== "POST" || pathName !== "/v1/chat/completions") {
          sendJson(res, 404, { error: { message: "not found" } });
          return;
        }

        const body = await readJsonRequest(req);
        requests.push(body);

        sendJson(res, 200, {
          id: "chatcmpl_e2e_openai",
          model: "gpt-4.1-mini",
          usage: {
            total_tokens: 64,
          },
          choices: [
            {
              message: {
                content: JSON.stringify(plan),
              },
            },
          ],
        });
      })().catch((error: unknown) => {
        sendJson(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    requests,
    close: () => closeServer(server),
  };
}

async function allocatePort(): Promise<number> {
  const { createServer } = await import("node:net");

  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }

      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function onceExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    sleep(timeoutMs),
  ]);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

async function readJsonRequest(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
