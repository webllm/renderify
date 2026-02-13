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
import { type Browser, chromium } from "playwright";

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

test("e2e: cli render-plan executes plan file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "renderify-e2e-plan-"));

  try {
    const result = await runCli(
      ["render-plan", "examples/runtime/counter-plan.json"],
      {
        RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Count: 0/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli rejects invalid runtime plan file", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-invalid-plan-"),
  );
  const invalidPlanPath = path.join(tempDir, "bad-plan.json");

  try {
    await writeFile(invalidPlanPath, '{"id":"bad"}', "utf8");

    const result = await runCli(["render-plan", invalidPlanPath], {
      RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
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
      RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /runtime source works/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli probe-plan reports dependency preflight failures", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-probe-plan-"),
  );
  const probePlanPath = path.join(tempDir, "probe-plan.json");

  try {
    const probePlan = {
      specVersion: "runtime-plan/v1",
      id: "probe_plan_preflight",
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
            value: "fallback probe root",
          },
        ],
      },
      source: {
        language: "js",
        code: [
          'import "./styles.css";',
          "export default () => ({ type: 'text', value: 'ok' });",
        ].join("\n"),
      },
    };

    await writeFile(probePlanPath, JSON.stringify(probePlan, null, 2), "utf8");

    const result = await runCli(["probe-plan", probePlanPath], {
      RENDERIFY_RUNTIME_PREFLIGHT: "true",
      RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      dependencyStatuses?: Array<{
        usage?: string;
        ok?: boolean;
      }>;
      runtimeDiagnostics: Array<{ code?: string }>;
    };

    assert.equal(report.ok, false);
    assert.ok(Array.isArray(report.dependencyStatuses));
    assert.ok(
      report.dependencyStatuses?.some(
        (item) => item.usage === "source-import" && item.ok === false,
      ),
    );
    assert.ok(
      report.runtimeDiagnostics.some(
        (item) =>
          item.code === "RUNTIME_PREFLIGHT_SOURCE_IMPORT_RELATIVE_UNRESOLVED",
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: cli uses openai provider when configured", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-openai-"),
  );
  const port = await allocatePort();
  const { requests, close } = await startFakeOpenAIServer(port);

  try {
    const result = await runCli(["plan", "runtime from openai provider"], {
      RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
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

test("e2e: cli uses google provider when configured", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-google-"),
  );
  const port = await allocatePort();
  const { requests, close } = await startFakeGoogleServer(port);

  try {
    const result = await runCli(["plan", "runtime from google provider"], {
      RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
      RENDERIFY_LLM_PROVIDER: "google",
      RENDERIFY_LLM_API_KEY: "test-google-key",
      RENDERIFY_LLM_BASE_URL: `http://127.0.0.1:${port}/v1beta`,
      RENDERIFY_LLM_MODEL: "gemini-2.0-flash",
    });

    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout.trim()) as {
      id: string;
      version: number;
      root: {
        type: string;
      };
    };

    assert.equal(plan.id, "fake_google_plan");
    assert.equal(plan.version, 1);
    assert.equal(plan.root.type, "element");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.get("x-goog-api-key"), "test-google-key");

    const generationConfig = requests[0].body.generationConfig as {
      responseMimeType?: string;
    };
    assert.equal(generationConfig.responseMimeType, "application/json");
  } finally {
    await close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: playground api supports prompt and stream flow", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-playground-"),
  );
  const port = await allocatePort();
  const openaiPort = await allocatePort();
  const { close } = await startFakeOpenAIServer(openaiPort);
  const baseUrl = `http://127.0.0.1:${port}`;

  const processHandle = startPlayground(port, {
    RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
    RENDERIFY_LLM_PROVIDER: "openai",
    RENDERIFY_LLM_API_KEY: "test-key",
    RENDERIFY_LLM_BASE_URL: `http://127.0.0.1:${openaiPort}/v1`,
    RENDERIFY_LLM_MODEL: "gpt-4.1-mini",
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`, 10000);

    const promptResponse = await fetchJson(`${baseUrl}/api/prompt`, {
      method: "POST",
      body: {
        prompt: "e2e playground prompt",
      },
    });
    const promptBody = promptResponse.body as {
      traceId?: unknown;
      html?: unknown;
      plan?: { id?: unknown };
    };
    assert.equal(promptResponse.status, 200);
    assert.equal(typeof promptBody.traceId, "string");
    assert.equal(typeof promptBody.html, "string");
    assert.equal(typeof promptBody.plan?.id, "string");

    const streamEvents = await fetchNdjson(`${baseUrl}/api/prompt-stream`, {
      prompt: "e2e playground stream",
    });
    assert.ok(streamEvents.length > 0);
    assert.ok(streamEvents.some((item) => item.type === "llm-delta"));
    assert.ok(streamEvents.some((item) => item.type === "final"));

    const probeResponse = await fetchJson(`${baseUrl}/api/probe-plan`, {
      method: "POST",
      body: {
        plan: {
          specVersion: "runtime-plan/v1",
          id: "playground_probe_plan",
          version: 1,
          capabilities: { domWrite: true },
          root: {
            type: "element",
            tag: "section",
            children: [{ type: "text", value: "probe" }],
          },
        },
      },
    });
    assert.equal(probeResponse.status, 200);
    const probeBody = probeResponse.body as {
      safe?: unknown;
      runtimeDiagnostics?: unknown;
    };
    assert.equal(probeBody.safe, true);
    assert.ok(Array.isArray(probeBody.runtimeDiagnostics));
  } finally {
    processHandle.kill("SIGTERM");
    await onceExit(processHandle, 3000);
    await close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: playground api auto-hydrates moduleManifest for bare specifiers", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-playground-manifest-auto-"),
  );
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const processHandle = startPlayground(port, {
    RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`, 10000);

    const response = await fetchJson(`${baseUrl}/api/plan`, {
      method: "POST",
      body: {
        plan: {
          specVersion: "runtime-plan/v1",
          id: "playground_auto_manifest_plan",
          version: 1,
          capabilities: {
            domWrite: true,
            allowedModules: ["recharts"],
          },
          root: {
            type: "element",
            tag: "section",
            children: [{ type: "text", value: "auto manifest" }],
          },
        },
      },
    });

    assert.equal(response.status, 200);
    const payload = response.body as {
      html?: unknown;
      planDetail?: {
        moduleManifest?: {
          recharts?: {
            resolvedUrl?: unknown;
          };
        };
      };
    };

    assert.match(String(payload.html ?? ""), /auto manifest/);
    assert.equal(
      typeof payload.planDetail?.moduleManifest?.recharts?.resolvedUrl,
      "string",
    );
    assert.match(
      String(payload.planDetail?.moduleManifest?.recharts?.resolvedUrl ?? ""),
      /recharts/i,
    );
  } finally {
    processHandle.kill("SIGTERM");
    await onceExit(processHandle, 3000);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: playground hash plan64 auto-renders on load", async (t) => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-playground-hash-plan64-"),
  );
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const processHandle = startPlayground(port, {
    RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
  });

  let browser: Browser | undefined;

  try {
    await waitForHealth(`${baseUrl}/api/health`, 10000);

    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      t.skip(
        `playwright chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const page = await browser.newPage();
    const plan = {
      specVersion: "runtime-plan/v1",
      id: "playground_hash_plan64",
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
            value: "Hello from plan64 hash",
          },
        ],
      },
    };
    const plan64 = toBase64Url(JSON.stringify(plan));

    await page.goto(`${baseUrl}/#plan64=${plan64}`, {
      waitUntil: "networkidle",
    });

    await page.waitForFunction(() => {
      const status = document.getElementById("status")?.textContent ?? "";
      return (
        status.includes("Hash payload rendered.") ||
        status.includes("Hash payload render failed.")
      );
    });

    const status = await page.textContent("#status");
    assert.match(status ?? "", /Hash payload rendered./);

    const htmlOutput = await page.textContent("#html-output");
    assert.match(htmlOutput ?? "", /Hello from plan64 hash/);

    const planEditorValue = await page.inputValue("#plan-editor");
    const parsed = JSON.parse(planEditorValue) as { id?: string };
    assert.equal(parsed.id, "playground_hash_plan64");
  } finally {
    await browser?.close();
    processHandle.kill("SIGTERM");
    await onceExit(processHandle, 3000);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: playground hash js64 source auto-renders on load", async (t) => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "renderify-e2e-playground-hash-js64-"),
  );
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const processHandle = startPlayground(port, {
    RENDERIFY_SESSION_FILE: path.join(tempDir, "session.json"),
  });

  let browser: Browser | undefined;

  try {
    await waitForHealth(`${baseUrl}/api/health`, 10000);

    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      t.skip(
        `playwright chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const page = await browser.newPage();
    const sourceCode = [
      "export default () => ({",
      "  type: 'element',",
      "  tag: 'section',",
      "  children: [{ type: 'text', value: 'Hello from js64 hash source' }],",
      "});",
    ].join("\n");
    const source64 = toBase64Url(sourceCode);

    await page.goto(
      `${baseUrl}/#js64=${source64}&runtime=renderify&id=playground_hash_source_js64`,
      {
        waitUntil: "networkidle",
      },
    );

    await page.waitForFunction(() => {
      const status = document.getElementById("status")?.textContent ?? "";
      return (
        status.includes("Hash payload rendered.") ||
        status.includes("Hash payload render failed.")
      );
    });

    const status = await page.textContent("#status");
    assert.match(status ?? "", /Hash payload rendered./);

    const htmlOutput = await page.textContent("#html-output");
    assert.match(htmlOutput ?? "", /Hello from js64 hash source/);

    const planEditorValue = await page.inputValue("#plan-editor");
    const parsed = JSON.parse(planEditorValue) as {
      id?: string;
      source?: {
        language?: string;
        runtime?: string;
      };
    };

    assert.equal(parsed.id, "playground_hash_source_js64");
    assert.equal(parsed.source?.language, "js");
    assert.equal(parsed.source?.runtime, "renderify");
  } finally {
    await browser?.close();
    processHandle.kill("SIGTERM");
    await onceExit(processHandle, 3000);
    await rm(tempDir, { recursive: true, force: true });
  }
});

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

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

async function fetchNdjson(
  url: string,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`NDJSON request failed with status ${response.status}`);
  }

  const text = await response.text();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
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

async function startFakeGoogleServer(port: number): Promise<{
  requests: Array<{ headers: Headers; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
    [];
  const plan = {
    id: "fake_google_plan",
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
          value: "Google provider plan",
        },
      ],
    },
  };

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      void (async () => {
        const method = (req.method ?? "GET").toUpperCase();
        const pathName = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

        if (
          method !== "POST" ||
          pathName !== "/v1beta/models/gemini-2.0-flash:generateContent"
        ) {
          sendJson(res, 404, { error: { message: "not found" } });
          return;
        }

        const body = await readJsonRequest(req);
        requests.push({
          headers: new Headers(req.headers as HeadersInit),
          body,
        });

        sendJson(res, 200, {
          modelVersion: "gemini-2.0-flash",
          usageMetadata: {
            totalTokenCount: 48,
          },
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify(plan),
                  },
                ],
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
