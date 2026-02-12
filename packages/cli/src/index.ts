import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  createRenderifyApp,
  DefaultApiIntegration,
  DefaultCodeGenerator,
  DefaultContextManager,
  DefaultCustomizationEngine,
  DefaultPerformanceOptimizer,
  DefaultRenderifyConfig,
  DefaultSecurityChecker,
  DefaultUIRenderer,
  type LLMInterpreter,
  type LLMProviderConfig,
  type RenderifyApp,
  type RenderPlanResult,
  type RenderPromptResult,
  type RenderPromptStreamChunk,
} from "@renderify/core";
import { isRuntimePlan, type RuntimePlan } from "@renderify/ir";
import { createLLMInterpreter } from "@renderify/llm";
import { DefaultRuntimeManager, JspmModuleLoader } from "@renderify/runtime";

interface CliArgs {
  command:
    | "run"
    | "plan"
    | "probe-plan"
    | "render-plan"
    | "playground"
    | "help";
  prompt?: string;
  planFile?: string;
  port?: number;
}

interface PlaygroundServerOptions {
  app: RenderifyApp;
  port: number;
}

const DEFAULT_PROMPT = "Hello Renderify runtime";
const DEFAULT_PORT = 4317;
const JSON_BODY_LIMIT_BYTES = 1_000_000;
const { readFile } = fs.promises;

function createLLM(config: DefaultRenderifyConfig): LLMInterpreter {
  const provider = config.get<LLMProviderConfig>("llmProvider") ?? "openai";
  const providerOptions: Record<string, unknown> = {
    apiKey: config.get<string>("llmApiKey"),
    timeoutMs: config.get<number>("llmRequestTimeoutMs"),
  };

  if (
    provider === "openai" ||
    provider === "google" ||
    typeof process.env.RENDERIFY_LLM_MODEL === "string"
  ) {
    providerOptions.model = config.get<string>("llmModel");
  }

  if (
    provider === "openai" ||
    provider === "google" ||
    typeof process.env.RENDERIFY_LLM_BASE_URL === "string"
  ) {
    providerOptions.baseUrl = config.get<string>("llmBaseUrl");
  }

  return createLLMInterpreter({
    provider,
    providerOptions,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    return;
  }

  const config = new DefaultRenderifyConfig();
  await config.load();
  const llm = createLLM(config);

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new JspmModuleLoader({
      cdnBaseUrl: config.get<string>("jspmCdnUrl"),
    }),
    enforceModuleManifest:
      config.get<boolean>("runtimeEnforceModuleManifest") !== false,
    allowIsolationFallback:
      config.get<boolean>("runtimeAllowIsolationFallback") === true,
    supportedPlanSpecVersions: config.get<string[]>(
      "runtimeSupportedSpecVersions",
    ),
    enableDependencyPreflight:
      config.get<boolean>("runtimeEnableDependencyPreflight") !== false,
    failOnDependencyPreflightError:
      config.get<boolean>("runtimeFailOnDependencyPreflightError") === true,
    remoteFetchTimeoutMs:
      config.get<number>("runtimeRemoteFetchTimeoutMs") ?? 12000,
    remoteFetchRetries: config.get<number>("runtimeRemoteFetchRetries") ?? 2,
    remoteFetchBackoffMs:
      config.get<number>("runtimeRemoteFetchBackoffMs") ?? 150,
    remoteFallbackCdnBases: config.get<string[]>(
      "runtimeRemoteFallbackCdnBases",
    ) ?? ["https://esm.sh"],
  });

  const renderifyApp = createRenderifyApp({
    config,
    context: new DefaultContextManager(),
    llm,
    codegen: new DefaultCodeGenerator(),
    runtime,
    security: new DefaultSecurityChecker(),
    performance: new DefaultPerformanceOptimizer(),
    ui: new DefaultUIRenderer(),
    apiIntegration: new DefaultApiIntegration(),
    customization: new DefaultCustomizationEngine(),
  });

  await renderifyApp.start();

  try {
    switch (args.command) {
      case "run": {
        const result = await renderifyApp.renderPrompt(
          args.prompt ?? DEFAULT_PROMPT,
        );
        console.log(result.html);
        break;
      }
      case "plan": {
        const result = await renderifyApp.renderPrompt(
          args.prompt ?? DEFAULT_PROMPT,
        );
        console.log(JSON.stringify(result.plan, null, 2));
        break;
      }
      case "probe-plan": {
        if (!args.planFile) {
          throw new Error("probe-plan requires a JSON file path");
        }

        const plan = await loadPlanFile(args.planFile);
        const security = renderifyApp.getSecurityChecker().checkPlan(plan);
        const runtimeProbe = await runtime.probePlan(plan);
        const runtimeErrorDiagnostics = runtimeProbe.diagnostics.filter(
          (item) => item.level === "error",
        );
        const preflightDiagnostics = runtimeProbe.diagnostics.filter((item) =>
          item.code.startsWith("RUNTIME_PREFLIGHT_"),
        );

        const report = {
          planId: plan.id,
          safe: security.safe,
          securityIssueCount: security.issues.length,
          runtimeErrorCount: runtimeErrorDiagnostics.length,
          preflightIssueCount: preflightDiagnostics.length,
          ok:
            security.safe &&
            security.issues.length === 0 &&
            runtimeErrorDiagnostics.length === 0,
          securityIssues: security.issues,
          securityDiagnostics: security.diagnostics,
          dependencyStatuses: runtimeProbe.dependencies,
          runtimeDiagnostics: runtimeProbe.diagnostics,
        };

        console.log(JSON.stringify(report, null, 2));
        break;
      }
      case "render-plan": {
        if (!args.planFile) {
          throw new Error("render-plan requires a JSON file path");
        }

        const plan = await loadPlanFile(args.planFile);
        const result = await renderifyApp.renderPlan(plan, {
          prompt: `render-plan:${path.basename(args.planFile)}`,
        });
        console.log(result.html);
        break;
      }
      case "playground": {
        const port = args.port ?? resolvePlaygroundPort();
        await runPlaygroundServer({
          app: renderifyApp,
          port,
        });
        break;
      }
    }
  } finally {
    await renderifyApp.stop();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const [rawCommand, ...rest] = argv;

  switch (rawCommand) {
    case undefined:
      return { command: "run", prompt: DEFAULT_PROMPT };
    case "run":
      return {
        command: "run",
        prompt: rest.join(" ").trim() || DEFAULT_PROMPT,
      };
    case "plan":
      return {
        command: "plan",
        prompt: rest.join(" ").trim() || DEFAULT_PROMPT,
      };
    case "probe-plan":
      return { command: "probe-plan", planFile: rest[0] };
    case "render-plan":
      return { command: "render-plan", planFile: rest[0] };
    case "playground":
      return {
        command: "playground",
        port: parsePort(rest[0]),
      };
    case "help":
      return { command: "help" };
    default:
      return {
        command: "run",
        prompt: [rawCommand, ...rest].join(" ").trim() || DEFAULT_PROMPT,
      };
  }
}

function parsePort(rawValue?: string): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${rawValue}`);
  }

  return parsed;
}

function resolvePlaygroundPort(): number {
  const candidates = [process.env.RENDERIFY_PLAYGROUND_PORT, process.env.PORT];

  for (const candidate of candidates) {
    const port = parsePortFromEnv(candidate);
    if (port !== undefined) {
      return port;
    }
  }

  return DEFAULT_PORT;
}

function parsePortFromEnv(rawValue?: string): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Usage:
  renderify run <prompt>                     Render prompt and print HTML
  renderify plan <prompt>                    Print runtime plan JSON
  renderify probe-plan <file>                Probe RuntimePlan dependencies and policy compatibility
  renderify render-plan <file>               Execute RuntimePlan JSON file
  renderify playground [port]                Start browser runtime playground`);
}

async function loadPlanFile(filePath: string): Promise<RuntimePlan> {
  const absolute = path.resolve(filePath);
  const content = await readFile(absolute, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (!isRuntimePlan(parsed)) {
    throw new Error(`Invalid RuntimePlan JSON in file: ${absolute}`);
  }

  return parsed;
}

async function runPlaygroundServer(
  options: PlaygroundServerOptions,
): Promise<void> {
  const { app, port } = options;

  const server = http.createServer((req, res) => {
    void handlePlaygroundRequest(req, res, app);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const info = server.address();
  const resolvedPort =
    typeof info === "object" && info !== null
      ? (info as AddressInfo).port
      : port;
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;
  console.log(`Renderify playground is running at ${baseUrl}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve, reject) => {
    let closed = false;

    const finalize = (error?: Error) => {
      if (closed) {
        return;
      }
      closed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const onSignal = () => {
      server.close((error) => {
        if (error) {
          finalize(error);
          return;
        }
        finalize();
      });
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function handlePlaygroundRequest(
  req: IncomingMessage,
  res: ServerResponse,
  app: RenderifyApp,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = parsedUrl.pathname;

  try {
    if (method === "GET" && pathname === "/") {
      sendHtml(res, PLAYGROUND_HTML);
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, status: "ready" });
      return;
    }

    if (method === "POST" && pathname === "/api/prompt") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;
      const result = await app.renderPrompt(prompt);
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/prompt-stream") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;

      await sendPromptStream(res, app, prompt);
      return;
    }

    if (method === "POST" && pathname === "/api/plan") {
      const body = await readJsonBody(req);
      const plan = body.plan;
      if (!isRuntimePlan(plan)) {
        sendJson(res, 400, { error: "body.plan must be a RuntimePlan object" });
        return;
      }

      const result = await app.renderPlan(plan, {
        prompt: "playground:plan",
      });
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/probe-plan") {
      const body = await readJsonBody(req);
      const plan = body.plan;
      if (!isRuntimePlan(plan)) {
        sendJson(res, 400, { error: "body.plan must be a RuntimePlan object" });
        return;
      }

      const security = app.getSecurityChecker().checkPlan(plan);
      const runtimeProbe = await app.getRuntimeManager().probePlan(plan);
      sendJson(res, 200, {
        safe: security.safe,
        securityIssues: security.issues,
        securityDiagnostics: security.diagnostics,
        dependencies: runtimeProbe.dependencies,
        runtimeDiagnostics: runtimeProbe.diagnostics,
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function serializeRenderResult(
  result: RenderPlanResult | RenderPromptResult,
): Record<string, unknown> {
  return {
    traceId: result.traceId,
    html: result.html,
    plan: {
      id: result.plan.id,
      version: result.plan.version,
    },
    planDetail: result.plan,
    diagnostics: result.execution.diagnostics,
    state: result.execution.state ?? {},
  };
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > JSON_BODY_LIMIT_BYTES) {
      throw new Error(`JSON body exceeds ${JSON_BODY_LIMIT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON body must be an object");
  }

  return parsed;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

async function sendPromptStream(
  res: ServerResponse,
  app: RenderifyApp,
  prompt: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  try {
    for await (const chunk of app.renderPromptStream(prompt)) {
      const serialized = serializePromptStreamChunk(chunk);
      res.write(`${JSON.stringify(serialized)}\n`);
    }
  } catch (error) {
    res.write(
      `${JSON.stringify({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  } finally {
    res.end();
  }
}

function serializePromptStreamChunk(
  chunk: RenderPromptStreamChunk,
): Record<string, unknown> {
  if (chunk.type === "final") {
    return {
      type: chunk.type,
      traceId: chunk.traceId,
      prompt: chunk.prompt,
      llmText: chunk.llmText,
      final: chunk.final ? serializeRenderResult(chunk.final) : undefined,
      html: chunk.html,
      diagnostics: chunk.diagnostics ?? [],
      planId: chunk.planId,
    };
  }

  return {
    type: chunk.type,
    traceId: chunk.traceId,
    prompt: chunk.prompt,
    llmText: chunk.llmText,
    delta: chunk.delta,
    html: chunk.html,
    diagnostics: chunk.diagnostics ?? [],
    planId: chunk.planId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Renderify Runtime Playground</title>
    <style>
      :root {
        --bg-top: #e7f3ff;
        --bg-bottom: #fff9f0;
        --panel: rgba(255, 255, 255, 0.86);
        --line: rgba(17, 24, 39, 0.12);
        --ink: #0f172a;
        --subtle: #475569;
        --brand: #0f766e;
        --brand-2: #0369a1;
        --danger: #b91c1c;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 10% 0%, var(--bg-top), var(--bg-bottom));
      }

      .shell {
        min-height: 100vh;
        padding: 20px;
      }

      .title {
        margin: 0 0 8px;
        font-size: 28px;
      }

      .sub {
        margin: 0 0 16px;
        color: var(--subtle);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 14px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        backdrop-filter: blur(8px);
      }

      .span-4 {
        grid-column: span 4;
      }

      .span-8 {
        grid-column: span 8;
      }

      .span-12 {
        grid-column: span 12;
      }

      h2 {
        margin: 0 0 10px;
        font-size: 16px;
      }

      textarea {
        width: 100%;
        min-height: 118px;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 11px;
        font: inherit;
        resize: vertical;
        background: #fff;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      button {
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 8px 12px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        background: linear-gradient(160deg, var(--brand), var(--brand-2));
        color: #fff;
      }

      button.secondary {
        background: #fff;
        color: var(--ink);
        border-color: var(--line);
      }

      button.danger {
        background: var(--danger);
      }

      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .status {
        min-height: 20px;
        margin-top: 10px;
        color: var(--subtle);
        font-size: 13px;
      }

      .render-output {
        min-height: 130px;
        border: 1px dashed rgba(15, 118, 110, 0.35);
        border-radius: 10px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.9);
      }

      pre {
        margin: 0;
        max-height: 360px;
        overflow: auto;
        padding: 10px;
        font-size: 12px;
        border-radius: 10px;
        background: #0f172a;
        color: #dbeafe;
      }

      @media (max-width: 980px) {
        .span-4,
        .span-8 {
          grid-column: span 12;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1 class="title">Renderify Playground</h1>
      <p class="sub">Prompt -> RuntimePlan -> Runtime execution -> Browser render</p>

      <div class="grid">
        <section class="card span-4">
          <h2>Prompt</h2>
          <textarea id="prompt">Build an analytics dashboard with a chart and KPI cards</textarea>
          <div class="actions">
            <button id="run-prompt">Render Prompt</button>
            <button id="stream-prompt" class="secondary">Stream Prompt</button>
            <button id="clear" class="danger">Clear</button>
          </div>
          <div class="status" id="status">Ready.</div>
        </section>

        <section class="card span-8">
          <h2>Rendered HTML</h2>
          <div class="render-output" id="html-output"></div>
        </section>

        <section class="card span-6">
          <h2>Plan JSON</h2>
          <textarea id="plan-editor">{}</textarea>
          <div class="actions">
            <button id="run-plan">Render Plan</button>
            <button id="probe-plan" class="secondary">Probe Plan</button>
          </div>
        </section>

        <section class="card span-6">
          <h2>Diagnostics</h2>
          <pre id="diagnostics">{}</pre>
        </section>

        <section class="card span-12">
          <h2>Streaming Feed</h2>
          <pre id="stream-output">[]</pre>
        </section>
      </div>
    </div>

    <script>
      const byId = (id) => document.getElementById(id);
      const statusEl = byId("status");
      const promptEl = byId("prompt");
      const htmlOutputEl = byId("html-output");
      const planEditorEl = byId("plan-editor");
      const diagnosticsEl = byId("diagnostics");
      const streamOutputEl = byId("stream-output");

      const controls = [
        byId("run-prompt"),
        byId("stream-prompt"),
        byId("run-plan"),
        byId("probe-plan"),
        byId("clear"),
      ];

      const setBusy = (busy) => {
        controls.forEach((button) => {
          button.disabled = busy;
        });
      };

      const setStatus = (text) => {
        statusEl.textContent = text;
      };

      const safeJson = (value) => {
        try {
          return JSON.stringify(value ?? {}, null, 2);
        } catch (error) {
          return String(error);
        }
      };

      async function request(path, method, body) {
        const response = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload && payload.error ? String(payload.error) : "request failed");
        }
        return payload;
      }

      const applyRenderPayload = (payload) => {
        htmlOutputEl.innerHTML = String(payload.html ?? "");
        planEditorEl.value = safeJson(payload.planDetail ?? {});
        diagnosticsEl.textContent = safeJson({
          traceId: payload.traceId,
          state: payload.state ?? {},
          diagnostics: payload.diagnostics ?? [],
        });
      };

      async function runPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering prompt...");
        try {
          const payload = await request("/api/prompt", "POST", { prompt });
          applyRenderPayload(payload);
          streamOutputEl.textContent = "[]";
          setStatus("Prompt rendered.");
        } catch (error) {
          setStatus("Prompt render failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function streamPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Streaming prompt...");
        const streamEvents = [];

        try {
          const response = await fetch("/api/prompt-stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt }),
          });

          if (!response.ok || !response.body) {
            throw new Error("stream request failed");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const event = JSON.parse(line);
              streamEvents.push({
                type: event.type,
                planId: event.planId ?? null,
                llmTextLength: String(event.llmText ?? "").length,
              });

              if (event.html) {
                htmlOutputEl.innerHTML = String(event.html);
              }
              if (event.type === "final" && event.final) {
                applyRenderPayload(event.final);
              }
            }
          }

          streamOutputEl.textContent = safeJson(streamEvents);
          setStatus("Stream completed.");
        } catch (error) {
          setStatus("Stream failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function runPlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering plan...");
        try {
          const plan = JSON.parse(raw);
          const payload = await request("/api/plan", "POST", { plan });
          applyRenderPayload(payload);
          setStatus("Plan rendered.");
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function probePlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        setBusy(true);
        setStatus("Probing plan...");
        try {
          const plan = JSON.parse(raw);
          const payload = await request("/api/probe-plan", "POST", { plan });
          diagnosticsEl.textContent = safeJson(payload);
          setStatus("Plan probe completed.");
        } catch (error) {
          setStatus("Plan probe failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      function clearAll() {
        htmlOutputEl.innerHTML = "";
        diagnosticsEl.textContent = "{}";
        streamOutputEl.textContent = "[]";
        setStatus("Cleared.");
      }

      byId("run-prompt").addEventListener("click", runPrompt);
      byId("stream-prompt").addEventListener("click", streamPrompt);
      byId("run-plan").addEventListener("click", runPlan);
      byId("probe-plan").addEventListener("click", probePlan);
      byId("clear").addEventListener("click", clearAll);
    </script>
  </body>
</html>`;

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
