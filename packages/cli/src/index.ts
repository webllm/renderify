import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DefaultApiIntegration } from "@renderify/api-integration";
import { DefaultCodeGenerator } from "@renderify/codegen";
import {
  DefaultRenderifyConfig,
  type LLMProviderConfig,
} from "@renderify/config";
import { DefaultContextManager } from "@renderify/context";
import {
  createRenderifyApp,
  DefaultPerformanceOptimizer,
  type ExecutionAuditRecord,
  InMemoryExecutionAuditLog,
  InMemoryPlanRegistry,
  type RenderifyApp,
  type RenderPlanResult,
  type RenderPromptResult,
  type RenderPromptStreamChunk,
} from "@renderify/core";
import { DefaultCustomizationEngine } from "@renderify/customization";
import {
  asJsonValue,
  isRuntimePlan,
  type JsonValue,
  type RuntimeEvent,
  type RuntimePlan,
  type RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  DefaultLLMInterpreter,
  type LLMInterpreter,
} from "@renderify/llm-interpreter";
import { OpenAILLMInterpreter } from "@renderify/llm-openai";
import { DefaultRuntimeManager } from "@renderify/runtime";
import { JspmModuleLoader } from "@renderify/runtime-jspm";
import { DefaultSecurityChecker } from "@renderify/security";
import { DefaultUIRenderer } from "@renderify/ui";

interface CliSessionData {
  plans: RuntimePlan[];
  audits: ExecutionAuditRecord[];
  states: Record<string, RuntimeStateSnapshot>;
}

interface CliArgs {
  command:
    | "run"
    | "plan"
    | "render-plan"
    | "event"
    | "state"
    | "history"
    | "rollback"
    | "replay"
    | "clear-history"
    | "playground"
    | "help";
  prompt?: string;
  planFile?: string;
  planId?: string;
  version?: number;
  traceId?: string;
  eventType?: string;
  payloadJson?: string;
  port?: number;
}

interface PlaygroundServerOptions {
  app: RenderifyApp;
  port: number;
  persistSession: () => Promise<void>;
}

const DEFAULT_PROMPT = "Hello Renderify runtime";
const DEFAULT_PORT = 4317;
const JSON_BODY_LIMIT_BYTES = 1_000_000;
const { readFile, mkdir, writeFile } = fs.promises;

function createLLM(config: DefaultRenderifyConfig): LLMInterpreter {
  const provider = config.get<LLMProviderConfig>("llmProvider") ?? "mock";

  if (provider === "openai") {
    return new OpenAILLMInterpreter({
      apiKey: config.get<string>("llmApiKey"),
      model: config.get<string>("llmModel"),
      baseUrl: config.get<string>("llmBaseUrl"),
      timeoutMs: config.get<number>("llmRequestTimeoutMs"),
    });
  }

  const llm = new DefaultLLMInterpreter();
  llm.configure({
    model: config.get<string>("llmModel"),
  });
  return llm;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    return;
  }

  const sessionPath = resolveSessionPath();
  const persisted = await loadSessionData(sessionPath);

  const planRegistry = new InMemoryPlanRegistry();
  for (const plan of persisted.plans) {
    planRegistry.register(plan);
  }

  const auditLog = new InMemoryExecutionAuditLog();
  for (const audit of persisted.audits) {
    auditLog.append(audit);
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
    planRegistry,
    auditLog,
  });

  await renderifyApp.start();

  for (const [planId, state] of Object.entries(persisted.states)) {
    renderifyApp.setPlanState(planId, state);
  }

  const persistSession = async (): Promise<void> => {
    await saveSessionData(sessionPath, {
      plans: flattenPlans(renderifyApp.listPlans(), (planId, version) =>
        renderifyApp.getPlan(planId, version),
      ),
      audits: renderifyApp.listAudits(),
      states: collectStates(renderifyApp),
    });
  };

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
      case "event": {
        if (!args.planId || !args.eventType) {
          throw new Error("event requires <planId> <eventType> [payloadJson]");
        }

        const event = parseEvent(args.eventType, args.payloadJson);
        const result = await renderifyApp.dispatchEvent(args.planId, event);
        console.log(result.html);
        break;
      }
      case "state": {
        if (!args.planId) {
          throw new Error("state requires <planId>");
        }

        const state = renderifyApp.getPlanState(args.planId);
        console.log(JSON.stringify(state ?? {}, null, 2));
        break;
      }
      case "history": {
        printHistory(
          renderifyApp.listPlans(),
          renderifyApp.listAudits(50),
          collectStates(renderifyApp),
        );
        break;
      }
      case "rollback": {
        if (!args.planId || args.version === undefined) {
          throw new Error("rollback requires <planId> <version>");
        }
        const result = await renderifyApp.rollbackPlan(
          args.planId,
          args.version,
        );
        console.log(result.html);
        break;
      }
      case "replay": {
        if (!args.traceId) {
          throw new Error("replay requires <traceId>");
        }
        const result = await renderifyApp.replayTrace(args.traceId);
        console.log(result.html);
        break;
      }
      case "clear-history": {
        renderifyApp.clearHistory();
        console.log("history cleared");
        break;
      }
      case "playground": {
        const port = args.port ?? resolvePlaygroundPort();
        await runPlaygroundServer({
          app: renderifyApp,
          port,
          persistSession,
        });
        break;
      }
    }
  } finally {
    await persistSession();
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
    case "render-plan":
      return { command: "render-plan", planFile: rest[0] };
    case "event":
      return {
        command: "event",
        planId: rest[0],
        eventType: rest[1],
        payloadJson: rest[2],
      };
    case "state":
      return {
        command: "state",
        planId: rest[0],
      };
    case "history":
      return { command: "history" };
    case "rollback":
      return {
        command: "rollback",
        planId: rest[0],
        version: rest[1] ? Number(rest[1]) : undefined,
      };
    case "replay":
      return {
        command: "replay",
        traceId: rest[0],
      };
    case "clear-history":
      return { command: "clear-history" };
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
  renderify render-plan <file>               Execute RuntimePlan JSON file
  renderify event <planId> <type> [payload]  Dispatch runtime event to a stored plan
  renderify state <planId>                   Print current runtime state for a plan
  renderify history                          Print persisted plan/audit/state history
  renderify rollback <id> <version>          Roll back to a persisted plan version
  renderify replay <traceId>                 Replay a previous trace
  renderify clear-history                    Remove persisted runtime history
  renderify playground [port]                Start browser runtime playground`);
}

function parseEvent(eventType: string, payloadJson?: string): RuntimeEvent {
  if (!payloadJson) {
    return { type: eventType };
  }

  const parsed = JSON.parse(payloadJson) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("event payload must be a JSON object");
  }

  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(parsed)) {
    payload[key] = asJsonValue(value);
  }

  return {
    type: eventType,
    payload,
  };
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

function resolveSessionPath(): string {
  const configured = process.env.RENDERIFY_SESSION_FILE;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  return path.resolve(process.cwd(), ".renderify", "session.json");
}

async function loadSessionData(filePath: string): Promise<CliSessionData> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliSessionData>;

    return {
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      audits: Array.isArray(parsed.audits) ? parsed.audits : [],
      states:
        typeof parsed.states === "object" && parsed.states !== null
          ? (parsed.states as Record<string, RuntimeStateSnapshot>)
          : {},
    };
  } catch {
    return { plans: [], audits: [], states: {} };
  }
}

async function saveSessionData(
  filePath: string,
  data: CliSessionData,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function flattenPlans(
  summaries: Array<{ planId: string; versions: number[] }>,
  getter: (
    planId: string,
    version: number,
  ) => { plan: RuntimePlan } | undefined,
): RuntimePlan[] {
  const plans: RuntimePlan[] = [];

  for (const summary of summaries) {
    for (const version of summary.versions) {
      const record = getter(summary.planId, version);
      if (record) {
        plans.push(record.plan);
      }
    }
  }

  return plans;
}

function collectStates(
  app: Pick<RenderifyApp, "listPlans" | "getPlanState">,
): Record<string, RuntimeStateSnapshot> {
  const states: Record<string, RuntimeStateSnapshot> = {};

  for (const summary of app.listPlans()) {
    const state = app.getPlanState(summary.planId);
    if (state) {
      states[summary.planId] = state;
    }
  }

  return states;
}

function printHistory(
  planSummaries: Array<{
    planId: string;
    latestVersion: number;
    versions: number[];
  }>,
  audits: ExecutionAuditRecord[],
  states: Record<string, RuntimeStateSnapshot>,
): void {
  console.log("[plans]");
  if (planSummaries.length === 0) {
    console.log("  (none)");
  } else {
    for (const plan of planSummaries) {
      console.log(
        `  ${plan.planId} latest=${plan.latestVersion} versions=${plan.versions.join(",")}`,
      );
    }
  }

  console.log("[audits]");
  if (audits.length === 0) {
    console.log("  (none)");
  } else {
    for (const audit of audits) {
      const eventLabel = audit.event ? ` event=${audit.event.type}` : "";
      const tenantLabel = audit.tenantId ? ` tenant=${audit.tenantId}` : "";
      console.log(
        `  ${audit.traceId} mode=${audit.mode} status=${audit.status} plan=${audit.planId ?? "-"}@${audit.planVersion ?? "-"}${tenantLabel}${eventLabel}`,
      );
    }
  }

  console.log("[states]");
  if (Object.keys(states).length === 0) {
    console.log("  (none)");
    return;
  }

  for (const [planId, state] of Object.entries(states)) {
    console.log(`  ${planId} ${JSON.stringify(state)}`);
  }
}

async function runPlaygroundServer(
  options: PlaygroundServerOptions,
): Promise<void> {
  const { app, port, persistSession } = options;

  const server = http.createServer((req, res) => {
    void handlePlaygroundRequest(req, res, app, persistSession);
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
  persistSession: () => Promise<void>,
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

    if (method === "GET" && pathname === "/api/history") {
      sendJson(res, 200, {
        security: {
          profile: app.getSecurityChecker().getProfile(),
          policy: app.getSecurityChecker().getPolicy(),
        },
        tenantGovernor: {
          policy: app.getTenantGovernor().getPolicy(),
          snapshots: app.getTenantGovernor().listSnapshots(),
        },
        plans: app.listPlans(),
        audits: app.listAudits(100),
        states: collectStates(app),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      const planId = parsedUrl.searchParams.get("planId");
      if (!planId) {
        sendJson(res, 400, { error: "planId query param is required" });
        return;
      }

      sendJson(res, 200, {
        planId,
        state: app.getPlanState(planId) ?? {},
      });
      return;
    }

    if (method === "POST" && pathname === "/api/prompt") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;
      const result = await app.renderPrompt(prompt);
      await persistSession();
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/prompt-stream") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;

      await sendPromptStream(res, app, prompt, persistSession);
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
      await persistSession();
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/event") {
      const body = await readJsonBody(req);
      const planId = typeof body.planId === "string" ? body.planId.trim() : "";
      const eventType =
        typeof body.eventType === "string" ? body.eventType.trim() : "";

      if (!planId || !eventType) {
        sendJson(res, 400, { error: "planId and eventType are required" });
        return;
      }

      const payload = normalizePayload(body.payload);
      const event: RuntimeEvent = payload
        ? { type: eventType, payload }
        : { type: eventType };

      const result = await app.dispatchEvent(planId, event);
      await persistSession();
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/rollback") {
      const body = await readJsonBody(req);
      const planId = typeof body.planId === "string" ? body.planId.trim() : "";
      const version =
        typeof body.version === "number" ? body.version : Number(body.version);

      if (!planId || !Number.isInteger(version) || version < 1) {
        sendJson(res, 400, { error: "planId and valid version are required" });
        return;
      }

      const result = await app.rollbackPlan(planId, version);
      await persistSession();
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/replay") {
      const body = await readJsonBody(req);
      const traceId =
        typeof body.traceId === "string" ? body.traceId.trim() : "";

      if (!traceId) {
        sendJson(res, 400, { error: "traceId is required" });
        return;
      }

      const result = await app.replayTrace(traceId);
      await persistSession();
      sendJson(res, 200, serializeRenderResult(result));
      return;
    }

    if (method === "POST" && pathname === "/api/clear-history") {
      app.clearHistory();
      await persistSession();
      sendJson(res, 200, { cleared: true });
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
    audit: result.audit,
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

function normalizePayload(
  value: unknown,
): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const payload: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    payload[key] = asJsonValue(entry);
  }

  return payload;
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
  persistSession: () => Promise<void>,
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

      if (chunk.type === "final") {
        await persistSession();
      }
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
        --bg-top: #f1f7ff;
        --bg-bottom: #fff8ef;
        --panel: rgba(255, 255, 255, 0.82);
        --line: rgba(17, 24, 39, 0.12);
        --ink: #111827;
        --subtle: #475569;
        --brand: #0f766e;
        --danger: #b91c1c;
        --radius: 14px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background: linear-gradient(160deg, var(--bg-top), var(--bg-bottom));
      }

      .shell {
        min-height: 100vh;
        padding: 20px;
      }

      .title {
        margin: 0 0 14px;
        font-size: 28px;
        letter-spacing: 0.4px;
      }

      .sub {
        margin: 0 0 18px;
        color: var(--subtle);
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(360px, 520px) 1fr;
        gap: 16px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        backdrop-filter: blur(8px);
        padding: 14px;
      }

      .panel h2 {
        margin: 4px 0 10px;
        font-size: 16px;
      }

      .group {
        margin-bottom: 12px;
      }

      label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: var(--subtle);
        margin-bottom: 4px;
      }

      input,
      textarea,
      button {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--line);
        font: inherit;
      }

      input,
      textarea {
        padding: 9px 11px;
        background: rgba(255, 255, 255, 0.9);
      }

      textarea {
        min-height: 80px;
        resize: vertical;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .row-3 {
        display: grid;
        grid-template-columns: 2fr 1fr 1fr;
        gap: 8px;
      }

      button {
        padding: 10px 12px;
        border: 0;
        font-weight: 700;
        cursor: pointer;
      }

      .primary {
        background: var(--brand);
        color: white;
      }

      .muted {
        background: #e2e8f0;
        color: #0f172a;
      }

      .danger {
        background: #fee2e2;
        color: var(--danger);
      }

      pre {
        margin: 0;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.9);
        overflow: auto;
        max-height: 180px;
        font-size: 12px;
        line-height: 1.45;
      }

      .preview {
        min-height: 420px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: white;
        padding: 14px;
      }

      .status {
        margin-top: 10px;
        color: var(--subtle);
        font-size: 12px;
      }

      @media (max-width: 980px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1 class="title">Renderify Runtime Playground</h1>
      <p class="sub">No build-per-change: prompt/plan/event execute directly in runtime.</p>
      <div class="layout">
        <div class="panel">
          <h2>Prompt</h2>
          <div class="group">
            <label for="prompt-input">Prompt</label>
            <textarea id="prompt-input">Build an analytics dashboard with a chart and KPI toggle buttons</textarea>
          </div>
          <button id="prompt-run" class="primary">Run Prompt</button>

          <h2>Plan</h2>
          <div class="group">
            <label for="plan-input">RuntimePlan JSON</label>
            <textarea id="plan-input"></textarea>
          </div>
          <button id="plan-run" class="primary">Run Plan</button>

          <h2>Event</h2>
          <div class="row">
            <div class="group">
              <label for="event-plan-id">Plan ID</label>
              <input id="event-plan-id" placeholder="plan_xxx" />
            </div>
            <div class="group">
              <label for="event-type">Event Type</label>
              <input id="event-type" placeholder="increment" value="increment" />
            </div>
          </div>
          <div class="group">
            <label for="event-payload">Payload JSON (optional)</label>
            <textarea id="event-payload">{"count":1}</textarea>
          </div>
          <button id="event-run" class="primary">Dispatch Event</button>

          <h2>Ops</h2>
          <div class="row-3">
            <div class="group">
              <label for="rollback-plan-id">Rollback Plan</label>
              <input id="rollback-plan-id" placeholder="plan_xxx" />
            </div>
            <div class="group">
              <label for="rollback-version">Version</label>
              <input id="rollback-version" placeholder="1" />
            </div>
            <div class="group" style="align-self:end;">
              <button id="rollback-run" class="muted">Rollback</button>
            </div>
          </div>
          <div class="row">
            <div class="group">
              <label for="replay-trace-id">Replay Trace ID</label>
              <input id="replay-trace-id" placeholder="trace_xxx" />
            </div>
            <div class="group" style="align-self:end;">
              <button id="replay-run" class="muted">Replay</button>
            </div>
          </div>
          <button id="clear-history" class="danger">Clear History</button>

          <h2>State</h2>
          <div class="row">
            <div class="group">
              <label for="state-plan-id">Plan ID</label>
              <input id="state-plan-id" placeholder="plan_xxx" />
            </div>
            <div class="group" style="align-self:end;">
              <button id="state-refresh" class="muted">Refresh State</button>
            </div>
          </div>
          <pre id="state-output">{}</pre>

          <h2>History</h2>
          <button id="history-refresh" class="muted">Refresh History</button>
          <pre id="history-output">{}</pre>
        </div>

        <div class="panel">
          <h2>Rendered UI</h2>
          <div id="preview" class="preview"></div>
          <div id="status" class="status">idle</div>
          <h2>Last Result</h2>
          <pre id="result-output">{}</pre>
        </div>
      </div>
    </div>

    <script>
      const byId = (id) => document.getElementById(id);
      const preview = byId("preview");
      const status = byId("status");
      const resultOutput = byId("result-output");
      const historyOutput = byId("history-output");
      const stateOutput = byId("state-output");
      const BABEL_STANDALONE_URL =
        "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js";
      const BROWSER_MODULE_FALLBACKS = {
        preact: "https://esm.sh/preact@10.28.3",
        "preact/hooks": "https://esm.sh/preact@10.28.3/hooks",
        "preact/jsx-runtime":
          "https://esm.sh/preact@10.28.3/jsx-runtime",
        "preact/jsx-dev-runtime":
          "https://esm.sh/preact@10.28.3/jsx-runtime",
        recharts:
          "https://esm.sh/recharts@3.3.0?alias=react:preact/compat,react-dom:preact/compat",
        react: "https://esm.sh/preact@10.28.3/compat",
        "react-dom": "https://esm.sh/preact@10.28.3/compat",
        "react-dom/client": "https://esm.sh/preact@10.28.3/compat"
      };
      let babelStandalonePromise;

      const safeJson = (value) => {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      };

      const setStatus = (text) => {
        status.textContent = text;
      };

      const loadScript = (src) =>
        new Promise((resolve, reject) => {
          const existing = Array.from(document.querySelectorAll("script")).find(
            (entry) => entry.src === src
          );
          if (existing) {
            if (existing.dataset.loaded === "true") {
              resolve();
              return;
            }
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener(
              "error",
              () => reject(new Error("Failed to load script: " + src)),
              { once: true }
            );
            return;
          }

          const script = document.createElement("script");
          script.src = src;
          script.async = true;
          script.referrerPolicy = "no-referrer";
          script.addEventListener("load", () => {
            script.dataset.loaded = "true";
            resolve();
          });
          script.addEventListener(
            "error",
            () => reject(new Error("Failed to load script: " + src)),
            { once: true }
          );
          document.head.appendChild(script);
        });

      const ensureBabelStandalone = async () => {
        if (window.Babel && typeof window.Babel.transform === "function") {
          return window.Babel;
        }

        if (!babelStandalonePromise) {
          babelStandalonePromise = loadScript(BABEL_STANDALONE_URL).then(() => {
            if (window.Babel && typeof window.Babel.transform === "function") {
              return window.Babel;
            }
            throw new Error("Babel standalone is unavailable");
          });
        }

        return babelStandalonePromise;
      };

      const isRecord = (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value);

      const resolveManifestSpecifier = (specifier, moduleManifest) => {
        if (isRecord(BROWSER_MODULE_FALLBACKS) && BROWSER_MODULE_FALLBACKS[specifier]) {
          return BROWSER_MODULE_FALLBACKS[specifier];
        }

        if (isRecord(moduleManifest) && isRecord(moduleManifest[specifier])) {
          const resolvedUrl = String(moduleManifest[specifier].resolvedUrl || "").trim();
          if (resolvedUrl.length > 0) {
            return resolvedUrl;
          }
        }
        return specifier;
      };

      const rewriteImportsWithManifest = (code, moduleManifest) => {
        const patterns = [
          /\\bfrom\\s+["']([^"']+)["']/g,
          /\\bimport\\s+["']([^"']+)["']/g,
          /\\bimport\\s*\\(\\s*["']([^"']+)["']\\s*\\)/g
        ];

        return patterns.reduce((current, pattern) => {
          return current.replace(pattern, (full, specifier) => {
            const rewritten = resolveManifestSpecifier(specifier, moduleManifest);
            return full.replace(specifier, rewritten);
          });
        }, code);
      };

      const transpileSourceForBrowser = async (source) => {
        if (!isRecord(source) || typeof source.code !== "string") {
          throw new Error("Invalid runtime source payload");
        }

        const language = String(source.language || "js");
        if (language === "js") {
          return source.code;
        }

        const babel = await ensureBabelStandalone();
        const presets = [];

        if (language === "ts" || language === "tsx") {
          presets.push("typescript");
        }

        if (language === "jsx" || language === "tsx") {
          presets.push([
            "react",
            {
              runtime: "automatic",
              importSource: "preact"
            }
          ]);
        }

        const transformed = babel.transform(source.code, {
          sourceType: "module",
          presets,
          filename: "renderify-playground-source." + language,
          babelrc: false,
          configFile: false,
          comments: false
        });

        if (!transformed || typeof transformed.code !== "string") {
          throw new Error("Babel returned empty output");
        }

        return transformed.code;
      };

      const importSourceModuleFromCode = async (code) => {
        const blob = new Blob([code], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);

        try {
          return await import(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const renderSourcePlanInBrowser = async (plan, state) => {
        if (!isRecord(plan) || !isRecord(plan.source)) {
          return false;
        }

        const source = plan.source;
        const language = String(source.language || "js");
        const runtime =
          source.runtime ||
          (language === "tsx" || language === "jsx" ? "preact" : "renderify");

        if (runtime !== "preact") {
          return false;
        }

        const transpiled = await transpileSourceForBrowser(source);
        const rewritten = rewriteImportsWithManifest(
          transpiled,
          isRecord(plan.moduleManifest) ? plan.moduleManifest : undefined
        );
        const namespace = await importSourceModuleFromCode(rewritten);
        const exportName =
          typeof source.exportName === "string" && source.exportName.trim().length > 0
            ? source.exportName
            : "default";
        const selected = namespace ? namespace[exportName] : undefined;

        if (typeof selected !== "function") {
          throw new Error('Runtime source export "' + exportName + '" is not callable');
        }

        const preactSpecifier = resolveManifestSpecifier(
          "preact",
          isRecord(plan.moduleManifest) ? plan.moduleManifest : undefined
        );
        const preact = await import(preactSpecifier);
        if (
          !isRecord(preact) ||
          typeof preact.h !== "function" ||
          typeof preact.render !== "function"
        ) {
          throw new Error("Failed to load preact runtime in browser");
        }

        const runtimeInput = {
          context: {},
          state: isRecord(state) ? state : {},
          event: null
        };
        const vnode = preact.h(selected, runtimeInput);
        preact.render(vnode, preview);
        return true;
      };

      const applyRenderResult = async (payload) => {
        if (typeof payload.html === "string") {
          preview.innerHTML = payload.html;
        }

        if (payload.plan && payload.plan.id) {
          byId("event-plan-id").value = payload.plan.id;
          byId("rollback-plan-id").value = payload.plan.id;
          byId("state-plan-id").value = payload.plan.id;
        }

        if (payload.traceId) {
          byId("replay-trace-id").value = payload.traceId;
        }

        resultOutput.textContent = safeJson(payload);

        if (payload.planDetail) {
          try {
            await renderSourcePlanInBrowser(payload.planDetail, payload.state);
          } catch (error) {
            console.warn("Browser source render failed", error);
          }
        }
      };

      const request = async (url, method, body) => {
        const response = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || ("HTTP " + response.status));
        }
        return payload;
      };

      const requestPromptStream = async (prompt) => {
        const response = await fetch("/api/prompt-stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt })
        });

        if (!response.ok || !response.body) {
          let errorText = "Streaming request failed";
          try {
            const payload = await response.json();
            errorText = payload.error || errorText;
          } catch {}
          throw new Error(errorText);
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

          let newlineIndex = buffer.indexOf("\\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
              const payload = JSON.parse(line);
              if (payload.type === "error") {
                throw new Error(payload.error || "stream error");
              }
              await handleStreamChunk(payload);
            }

            newlineIndex = buffer.indexOf("\\n");
          }
        }
      };

      const handleStreamChunk = async (chunk) => {
        if (chunk.type === "llm-delta") {
          setStatus("streaming llm... " + chunk.llmText.length + " chars");
          return;
        }

        if (chunk.type === "preview") {
          if (typeof chunk.html === "string") {
            preview.innerHTML = chunk.html;
          }
          resultOutput.textContent = safeJson(chunk);
          setStatus("stream preview ready");
          return;
        }

        if (chunk.type === "final") {
          const finalPayload = chunk.final || chunk;
          await applyRenderResult(finalPayload);
          setStatus("prompt stream done");
        }
      };

      const runPrompt = async () => {
        setStatus("streaming prompt...");
        try {
          await requestPromptStream(byId("prompt-input").value);
          await refreshHistory();
          await refreshState();
        } catch (error) {
          setStatus("prompt failed");
          resultOutput.textContent = String(error);
        }
      };

      const runPlan = async () => {
        setStatus("running plan...");
        try {
          const plan = JSON.parse(byId("plan-input").value);
          const payload = await request("/api/plan", "POST", { plan });
          await applyRenderResult(payload);
          await refreshHistory();
          await refreshState();
          setStatus("plan done");
        } catch (error) {
          setStatus("plan failed");
          resultOutput.textContent = String(error);
        }
      };

      const runEvent = async () => {
        setStatus("dispatching event...");
        try {
          const payloadRaw = byId("event-payload").value.trim();
          const payload = payloadRaw ? JSON.parse(payloadRaw) : undefined;
          const result = await request("/api/event", "POST", {
            planId: byId("event-plan-id").value.trim(),
            eventType: byId("event-type").value.trim(),
            payload
          });
          await applyRenderResult(result);
          await refreshHistory();
          await refreshState();
          setStatus("event done");
        } catch (error) {
          setStatus("event failed");
          resultOutput.textContent = String(error);
        }
      };

      const runRollback = async () => {
        setStatus("rolling back...");
        try {
          const payload = await request("/api/rollback", "POST", {
            planId: byId("rollback-plan-id").value.trim(),
            version: Number(byId("rollback-version").value)
          });
          await applyRenderResult(payload);
          await refreshHistory();
          await refreshState();
          setStatus("rollback done");
        } catch (error) {
          setStatus("rollback failed");
          resultOutput.textContent = String(error);
        }
      };

      const runReplay = async () => {
        setStatus("replaying...");
        try {
          const payload = await request("/api/replay", "POST", {
            traceId: byId("replay-trace-id").value.trim()
          });
          await applyRenderResult(payload);
          await refreshHistory();
          await refreshState();
          setStatus("replay done");
        } catch (error) {
          setStatus("replay failed");
          resultOutput.textContent = String(error);
        }
      };

      const clearHistory = async () => {
        setStatus("clearing history...");
        try {
          await request("/api/clear-history", "POST", {});
          preview.innerHTML = "";
          resultOutput.textContent = "{}";
          await refreshHistory();
          await refreshState();
          setStatus("history cleared");
        } catch (error) {
          setStatus("clear failed");
          resultOutput.textContent = String(error);
        }
      };

      const refreshHistory = async () => {
        try {
          const payload = await request("/api/history", "GET");
          historyOutput.textContent = safeJson(payload);
        } catch (error) {
          historyOutput.textContent = String(error);
        }
      };

      const refreshState = async () => {
        const planId = byId("state-plan-id").value.trim();
        if (!planId) {
          stateOutput.textContent = "{}";
          return;
        }

        try {
          const payload = await request("/api/state?planId=" + encodeURIComponent(planId), "GET");
          stateOutput.textContent = safeJson(payload);
        } catch (error) {
          stateOutput.textContent = String(error);
        }
      };

      byId("prompt-run").addEventListener("click", runPrompt);
      byId("plan-run").addEventListener("click", runPlan);
      byId("event-run").addEventListener("click", runEvent);
      byId("rollback-run").addEventListener("click", runRollback);
      byId("replay-run").addEventListener("click", runReplay);
      byId("clear-history").addEventListener("click", clearHistory);
      byId("history-refresh").addEventListener("click", refreshHistory);
      byId("state-refresh").addEventListener("click", refreshState);

      byId("plan-input").value = safeJson({
        id: "playground_counter",
        version: 1,
        capabilities: { domWrite: true },
        state: {
          initial: { count: 0 },
          transitions: {
            increment: [{ type: "increment", path: "count", by: 1 }],
            reset: [{ type: "set", path: "count", value: 0 }]
          }
        },
        root: {
          type: "element",
          tag: "section",
          props: { class: "counter-shell" },
          children: [
            { type: "element", tag: "h2", children: [{ type: "text", value: "Runtime Counter" }] },
            { type: "element", tag: "p", children: [{ type: "text", value: "Count: {{state.count}}" }] }
          ]
        }
      });

      refreshHistory();
    </script>
  </body>
</html>`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
