import { createHash } from "node:crypto";
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
  DefaultUIRenderer,
  type LLMInterpreter,
  type LLMProviderConfig,
  type RenderifyApp,
  type RenderPlanResult,
  type RenderPromptResult,
  type RenderPromptStreamChunk,
} from "@renderify/core";
import {
  collectComponentModules,
  collectRuntimeSourceImports,
  isRuntimePlan,
  type RuntimeModuleDescriptor,
  type RuntimePlan,
} from "@renderify/ir";
import { createLLMInterpreter } from "@renderify/llm";
import {
  autoPinRuntimePlanModuleManifest,
  DefaultRuntimeManager,
  JspmModuleLoader,
} from "@renderify/runtime";
import { DefaultSecurityChecker } from "@renderify/security";
import { PLAYGROUND_HTML } from "./playground-html";

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
  debug?: boolean;
  llmLog?: boolean;
}

interface PlaygroundServerOptions {
  app: RenderifyApp;
  port: number;
  moduleLoader: JspmModuleLoader;
  autoManifestIntegrityTimeoutMs: number;
  debug: boolean;
  llmLog: boolean;
}

const DEFAULT_PROMPT = "Hello Renderify runtime";
const DEFAULT_PORT = 4317;
const DEFAULT_PLAYGROUND_MAX_EXECUTION_MS = 15000;
const JSON_BODY_LIMIT_BYTES = 1_000_000;
const AUTO_MANIFEST_INTEGRITY_TIMEOUT_MS = 8000;
const REMOTE_MODULE_INTEGRITY_CACHE = new Map<string, string>();
const DEBUG_RECENT_LOG_LIMIT = 120;
const LLM_LOG_INLINE_LIMIT = 10_000;
const LLM_LOG_TEXT_LIMIT = 4_000;
const LLM_SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|authorization|token|secret|password|cookie|session)/i;
const { readFile } = fs.promises;

interface PlaygroundDebugAggregate {
  key: string;
  count: number;
  errorCount: number;
  avgMs: number;
  maxMs: number;
  statusCodes: Record<string, number>;
}

interface PlaygroundDebugRecentRecord {
  id: number;
  ts: string;
  type: "inbound" | "outbound";
  method: string;
  target: string;
  statusCode?: number;
  durationMs?: number;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: string;
}

interface PlaygroundDebugSnapshot {
  enabled: true;
  startedAt: string;
  uptimeMs: number;
  inbound: {
    totalRequests: number;
    routes: PlaygroundDebugAggregate[];
  };
  outbound: {
    totalRequests: number;
    targets: PlaygroundDebugAggregate[];
  };
  recent: PlaygroundDebugRecentRecord[];
}

interface PlaygroundDebugStatsAccumulator {
  count: number;
  totalMs: number;
  maxMs: number;
  errorCount: number;
  statusCodes: Record<string, number>;
}

class PlaygroundDebugTracer {
  private readonly startedAtMs = Date.now();
  private readonly inboundRouteStats = new Map<
    string,
    PlaygroundDebugStatsAccumulator
  >();
  private readonly outboundTargetStats = new Map<
    string,
    PlaygroundDebugStatsAccumulator
  >();
  private readonly recentRecords: PlaygroundDebugRecentRecord[] = [];
  private nextRecordId = 1;
  private inboundCount = 0;
  private outboundCount = 0;

  logInboundStart(
    method: string,
    pathname: string,
    requestSummary?: Record<string, unknown>,
  ): void {
    this.printLog("inbound:start", method, pathname, requestSummary);
  }

  recordInbound(input: {
    method: string;
    pathname: string;
    statusCode: number;
    durationMs: number;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    error?: string;
  }): void {
    this.inboundCount += 1;
    const key = `${input.method} ${input.pathname}`;
    const accumulator = this.getOrCreateAccumulator(
      this.inboundRouteStats,
      key,
    );
    this.mergeAccumulator(
      accumulator,
      input.statusCode,
      input.durationMs,
      input.error,
    );

    this.pushRecent({
      type: "inbound",
      method: input.method,
      target: input.pathname,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      request: input.request,
      response: input.response,
      error: input.error,
    });

    this.printLog(
      "inbound:end",
      input.method,
      input.pathname,
      this.compactRecord({
        statusCode: input.statusCode,
        durationMs: input.durationMs,
        request: input.request,
        response: input.response,
        error: input.error,
      }),
    );
  }

  logOutboundStart(
    method: string,
    target: string,
    requestSummary?: Record<string, unknown>,
  ): void {
    this.printLog("outbound:start", method, target, requestSummary);
  }

  recordOutbound(input: {
    method: string;
    target: string;
    statusCode?: number;
    durationMs: number;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    error?: string;
  }): void {
    this.outboundCount += 1;
    const key = `${input.method} ${input.target}`;
    const accumulator = this.getOrCreateAccumulator(
      this.outboundTargetStats,
      key,
    );
    this.mergeAccumulator(
      accumulator,
      input.statusCode,
      input.durationMs,
      input.error,
    );

    this.pushRecent({
      type: "outbound",
      method: input.method,
      target: input.target,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      request: input.request,
      response: input.response,
      error: input.error,
    });

    this.printLog(
      "outbound:end",
      input.method,
      input.target,
      this.compactRecord({
        statusCode: input.statusCode,
        durationMs: input.durationMs,
        request: input.request,
        response: input.response,
        error: input.error,
      }),
    );
  }

  snapshot(): PlaygroundDebugSnapshot {
    return {
      enabled: true,
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: Date.now() - this.startedAtMs,
      inbound: {
        totalRequests: this.inboundCount,
        routes: this.toAggregates(this.inboundRouteStats),
      },
      outbound: {
        totalRequests: this.outboundCount,
        targets: this.toAggregates(this.outboundTargetStats),
      },
      recent: [...this.recentRecords],
    };
  }

  printSummary(): void {
    const snapshot = this.snapshot();
    const summary = {
      uptimeMs: snapshot.uptimeMs,
      inboundTotal: snapshot.inbound.totalRequests,
      outboundTotal: snapshot.outbound.totalRequests,
      topInbound: snapshot.inbound.routes.slice(0, 5),
      topOutbound: snapshot.outbound.targets.slice(0, 8),
    };
    console.log(
      `[playground-debug] ${new Date().toISOString()} summary ${safeInlineJson(summary)}`,
    );
  }

  private printLog(
    stage: string,
    method: string,
    target: string,
    details?: Record<string, unknown>,
  ): void {
    const suffix = details ? ` ${safeInlineJson(details)}` : "";
    console.log(
      `[playground-debug] ${new Date().toISOString()} ${stage} ${method} ${target}${suffix}`,
    );
  }

  private compactRecord(
    value: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const next = Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private getOrCreateAccumulator(
    map: Map<string, PlaygroundDebugStatsAccumulator>,
    key: string,
  ): PlaygroundDebugStatsAccumulator {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }

    const created: PlaygroundDebugStatsAccumulator = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      errorCount: 0,
      statusCodes: {},
    };
    map.set(key, created);
    return created;
  }

  private mergeAccumulator(
    accumulator: PlaygroundDebugStatsAccumulator,
    statusCode: number | undefined,
    durationMs: number,
    error: string | undefined,
  ): void {
    accumulator.count += 1;
    accumulator.totalMs += durationMs;
    accumulator.maxMs = Math.max(accumulator.maxMs, durationMs);

    if (typeof statusCode === "number") {
      const key = String(statusCode);
      accumulator.statusCodes[key] = (accumulator.statusCodes[key] ?? 0) + 1;
      if (statusCode >= 500) {
        accumulator.errorCount += 1;
      }
    }

    if (error) {
      accumulator.errorCount += 1;
    }
  }

  private pushRecent(
    input: Omit<PlaygroundDebugRecentRecord, "id" | "ts">,
  ): void {
    this.recentRecords.push({
      id: this.nextRecordId,
      ts: new Date().toISOString(),
      ...input,
    });
    this.nextRecordId += 1;
    if (this.recentRecords.length > DEBUG_RECENT_LOG_LIMIT) {
      this.recentRecords.splice(
        0,
        this.recentRecords.length - DEBUG_RECENT_LOG_LIMIT,
      );
    }
  }

  private toAggregates(
    map: Map<string, PlaygroundDebugStatsAccumulator>,
  ): PlaygroundDebugAggregate[] {
    return [...map.entries()]
      .map(([key, value]) => ({
        key,
        count: value.count,
        errorCount: value.errorCount,
        avgMs:
          value.count > 0
            ? Number((value.totalMs / value.count).toFixed(2))
            : 0,
        maxMs: value.maxMs,
        statusCodes: { ...value.statusCodes },
      }))
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }
        return left.key.localeCompare(right.key);
      });
  }
}

function createLLM(config: DefaultRenderifyConfig): LLMInterpreter {
  const provider = config.get<LLMProviderConfig>("llmProvider") ?? "openai";
  const providerOptions: Record<string, unknown> = {
    apiKey: config.get<string>("llmApiKey"),
    timeoutMs: config.get<number>("llmRequestTimeoutMs"),
    maxRetries: config.get<number>("llmMaxRetries"),
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
  const runtimeRemoteFallbackCdnBases = config.get<string[]>(
    "runtimeRemoteFallbackCdnBases",
  ) ?? ["https://esm.sh"];
  const runtimeRemoteFetchTimeoutMs =
    config.get<number>("runtimeRemoteFetchTimeoutMs") ?? 12000;
  const runtimeRemoteFetchRetries =
    config.get<number>("runtimeRemoteFetchRetries") ?? 2;
  const runtimeRemoteFetchBackoffMs =
    config.get<number>("runtimeRemoteFetchBackoffMs") ?? 150;

  const runtimeModuleLoader = new JspmModuleLoader({
    cdnBaseUrl: config.get<string>("jspmCdnUrl"),
    remoteFallbackCdnBases: runtimeRemoteFallbackCdnBases,
    remoteFetchTimeoutMs: runtimeRemoteFetchTimeoutMs,
    remoteFetchRetries: runtimeRemoteFetchRetries,
    remoteFetchBackoffMs: runtimeRemoteFetchBackoffMs,
  });

  const runtime = new DefaultRuntimeManager({
    moduleLoader: runtimeModuleLoader,
    defaultMaxExecutionMs:
      parsePositiveIntFromEnv(process.env.RENDERIFY_RUNTIME_MAX_EXECUTION_MS) ??
      DEFAULT_PLAYGROUND_MAX_EXECUTION_MS,
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
    remoteFetchTimeoutMs: runtimeRemoteFetchTimeoutMs,
    remoteFetchRetries: runtimeRemoteFetchRetries,
    remoteFetchBackoffMs: runtimeRemoteFetchBackoffMs,
    remoteFallbackCdnBases: runtimeRemoteFallbackCdnBases,
    browserSourceSandboxMode: config.get<
      "none" | "worker" | "iframe" | "shadowrealm"
    >("runtimeBrowserSourceSandboxMode"),
    browserSourceSandboxTimeoutMs:
      config.get<number>("runtimeBrowserSourceSandboxTimeoutMs") ?? 4000,
    browserSourceSandboxFailClosed:
      config.get<boolean>("runtimeBrowserSourceSandboxFailClosed") !== false,
  });
  const preloadSecurityChecker = new DefaultSecurityChecker();
  preloadSecurityChecker.initialize({
    profile: config.get<"strict" | "balanced" | "relaxed">("securityProfile"),
    overrides: config.get("securityPolicy"),
  });
  const requireIntegrityForHydration =
    preloadSecurityChecker.getPolicy().requireModuleIntegrity;

  const customization = new DefaultCustomizationEngine();
  if (args.command === "playground") {
    customization.registerPlugin({
      name: "playground-manifest-hydration",
      hooks: {
        beforePolicyCheck: async (payload) => {
          if (!isRuntimePlan(payload)) {
            return payload;
          }

          return hydratePlaygroundPlanManifest(payload, {
            moduleLoader: runtimeModuleLoader,
            requireIntegrity: requireIntegrityForHydration,
            integrityTimeoutMs: AUTO_MANIFEST_INTEGRITY_TIMEOUT_MS,
          });
        },
        beforeRuntime: async (payload) => {
          if (
            !isRecord(payload) ||
            !("plan" in payload) ||
            !isRuntimePlan(payload.plan)
          ) {
            return payload;
          }

          const runtimeInput = payload as {
            plan: RuntimePlan;
          };
          if (
            !(await shouldSkipPlaygroundServerSourceExecution(
              runtimeInput.plan,
            ))
          ) {
            return payload;
          }

          return {
            ...payload,
            plan: createPlaygroundClientOnlyExecutionPlan(runtimeInput.plan),
          };
        },
      },
    });
  }

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
    customization,
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
        const security = await renderifyApp
          .getSecurityChecker()
          .checkPlan(plan);
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
          moduleLoader: runtimeModuleLoader,
          autoManifestIntegrityTimeoutMs: AUTO_MANIFEST_INTEGRITY_TIMEOUT_MS,
          debug: args.debug ?? resolvePlaygroundDebugMode(),
          llmLog: args.llmLog ?? resolvePlaygroundLlmLogMode(),
        });
        break;
      }
    }
  } finally {
    await renderifyApp.stop();
  }
}

function parsePositiveIntFromEnv(rawValue?: string): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parsePlaygroundArgs(args: string[]): CliArgs {
  let port: number | undefined;
  let debug: boolean | undefined;
  let llmLog: boolean | undefined;

  for (const token of args) {
    const normalized = token.trim();
    if (normalized.length === 0) {
      continue;
    }

    if (normalized === "--debug") {
      debug = true;
      continue;
    }

    if (normalized === "--no-debug") {
      debug = false;
      continue;
    }

    if (normalized === "--llm-log") {
      llmLog = true;
      continue;
    }

    if (normalized === "--no-llm-log") {
      llmLog = false;
      continue;
    }

    if (normalized.startsWith("--")) {
      throw new Error(`Unknown playground option: ${normalized}`);
    }

    if (port !== undefined) {
      throw new Error(`Unexpected playground argument: ${normalized}`);
    }

    port = parsePort(normalized);
  }

  return {
    command: "playground",
    port,
    debug,
    llmLog,
  };
}

function resolvePlaygroundDebugMode(): boolean {
  const candidate = process.env.RENDERIFY_PLAYGROUND_DEBUG;
  if (!candidate) {
    return false;
  }

  return parseBooleanEnv(candidate);
}

function resolvePlaygroundLlmLogMode(): boolean {
  const candidate = process.env.RENDERIFY_PLAYGROUND_LLM_LOG;
  if (!candidate) {
    return true;
  }

  return parseBooleanEnv(candidate);
}

function parseBooleanEnv(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseArgs(argv: string[]): CliArgs {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }

  const [rawCommand, ...rest] = normalizedArgv;

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
        ...parsePlaygroundArgs(rest),
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
  renderify playground [port] [--debug] [--no-llm-log]      Start browser runtime playground`);
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
  const {
    app,
    port,
    moduleLoader,
    autoManifestIntegrityTimeoutMs,
    debug,
    llmLog,
  } = options;
  const debugTracer = debug ? new PlaygroundDebugTracer() : undefined;
  const restoreFetch =
    debugTracer || llmLog
      ? installPlaygroundFetchTracer({
          debugTracer,
          llmLog,
        })
      : undefined;

  const server = http.createServer((req, res) => {
    void handlePlaygroundRequest(
      req,
      res,
      app,
      moduleLoader,
      autoManifestIntegrityTimeoutMs,
      debugTracer,
    );
  });

  try {
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
    if (debugTracer) {
      console.log(
        "Playground debug mode is enabled. Inspect stats at /api/debug/stats.",
      );
    }
    if (llmLog) {
      console.log(
        "Playground LLM I/O logging is enabled. Set RENDERIFY_PLAYGROUND_LLM_LOG=false to disable.",
      );
    }
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
  } finally {
    if (restoreFetch) {
      restoreFetch();
    }
    debugTracer?.printSummary();
  }
}

async function handlePlaygroundRequest(
  req: IncomingMessage,
  res: ServerResponse,
  app: RenderifyApp,
  moduleLoader: JspmModuleLoader,
  autoManifestIntegrityTimeoutMs: number,
  debugTracer?: PlaygroundDebugTracer,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  const startedAtMs = Date.now();
  let requestSummary: Record<string, unknown> | undefined;
  let responseSummary: Record<string, unknown> | undefined;

  const finishDebug = (statusCode: number, error?: string): void => {
    if (!debugTracer) {
      return;
    }
    debugTracer.recordInbound({
      method,
      pathname,
      statusCode,
      durationMs: Date.now() - startedAtMs,
      request: requestSummary,
      response: responseSummary,
      error,
    });
  };

  try {
    if (method === "GET" && pathname === "/") {
      sendHtml(res, PLAYGROUND_HTML);
      responseSummary = { contentType: "text/html" };
      finishDebug(200);
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, status: "ready" });
      responseSummary = { ok: true };
      finishDebug(200);
      return;
    }

    if (method === "GET" && pathname === "/api/debug/stats") {
      if (!debugTracer) {
        const disabledSnapshot = {
          enabled: false,
          startedAt: undefined,
          uptimeMs: 0,
          inbound: {
            totalRequests: 0,
            routes: [],
          },
          outbound: {
            totalRequests: 0,
            targets: [],
          },
          recent: [],
          error:
            "Playground debug mode is disabled. Start with --debug or set RENDERIFY_PLAYGROUND_DEBUG=1.",
        };
        responseSummary = {
          enabled: false,
          inboundTotal: 0,
          outboundTotal: 0,
        };
        sendJson(res, 200, disabledSnapshot);
        finishDebug(200);
        return;
      }

      const snapshot = debugTracer.snapshot();
      responseSummary = {
        inboundTotal: snapshot.inbound.totalRequests,
        outboundTotal: snapshot.outbound.totalRequests,
      };
      sendJson(res, 200, snapshot);
      finishDebug(200);
      return;
    }

    if (method === "POST" && pathname === "/api/prompt") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;
      requestSummary = summarizePromptDebugInput(prompt);
      debugTracer?.logInboundStart(method, pathname, requestSummary);
      const result = await app.renderPrompt(prompt);
      const payload = serializeRenderResult(result);
      responseSummary = summarizeRenderResultDebugOutput(payload);
      sendJson(res, 200, payload);
      finishDebug(200);
      return;
    }

    if (method === "POST" && pathname === "/api/prompt-stream") {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : DEFAULT_PROMPT;
      requestSummary = summarizePromptDebugInput(prompt);
      debugTracer?.logInboundStart(method, pathname, requestSummary);

      const streamSummary = await sendPromptStream(res, app, prompt);
      responseSummary = streamSummary;
      finishDebug(200, streamSummary.streamErrorMessage);
      return;
    }

    if (method === "POST" && pathname === "/api/plan") {
      const body = await readJsonBody(req);
      const plan = body.plan;
      if (!isRuntimePlan(plan)) {
        requestSummary = { hasPlan: false };
        sendJson(res, 400, { error: "body.plan must be a RuntimePlan object" });
        responseSummary = { error: "invalid-plan-payload" };
        finishDebug(400);
        return;
      }
      requestSummary = summarizePlanDebugInput(plan);
      debugTracer?.logInboundStart(method, pathname, requestSummary);

      const normalizedPlan = await normalizePlaygroundPlanInput(app, plan, {
        promptFallback: "playground:plan",
      });
      const result = await app.renderPlan(normalizedPlan, {
        prompt: "playground:plan",
      });
      const payload = serializeRenderResult(result);
      responseSummary = summarizeRenderResultDebugOutput(payload);
      sendJson(res, 200, payload);
      finishDebug(200);
      return;
    }

    if (method === "POST" && pathname === "/api/probe-plan") {
      const body = await readJsonBody(req);
      const plan = body.plan;
      if (!isRuntimePlan(plan)) {
        requestSummary = { hasPlan: false };
        sendJson(res, 400, { error: "body.plan must be a RuntimePlan object" });
        responseSummary = { error: "invalid-plan-payload" };
        finishDebug(400);
        return;
      }
      requestSummary = summarizePlanDebugInput(plan);
      debugTracer?.logInboundStart(method, pathname, requestSummary);

      const normalizedPlan = await normalizePlaygroundPlanInput(app, plan, {
        promptFallback: "playground:probe-plan",
      });
      const hydratedPlan = await hydratePlaygroundPlanManifest(normalizedPlan, {
        moduleLoader,
        requireIntegrity: app.getSecurityChecker().getPolicy()
          .requireModuleIntegrity,
        integrityTimeoutMs: autoManifestIntegrityTimeoutMs,
      });

      const security = await app.getSecurityChecker().checkPlan(hydratedPlan);
      const runtimeProbe = await app
        .getRuntimeManager()
        .probePlan(hydratedPlan);
      const payload = {
        safe: security.safe,
        securityIssues: security.issues,
        securityDiagnostics: security.diagnostics,
        dependencies: runtimeProbe.dependencies,
        runtimeDiagnostics: runtimeProbe.diagnostics,
      };
      responseSummary = {
        safe: security.safe,
        securityIssueCount: security.issues.length,
        runtimeDiagnosticCount: runtimeProbe.diagnostics.length,
        dependencyCount: runtimeProbe.dependencies.length,
      };
      sendJson(res, 200, payload);
      finishDebug(200);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
    responseSummary = { error: "not-found" };
    finishDebug(404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: message,
    });
    responseSummary = { error: message };
    finishDebug(500, message);
  }
}

function serializeRenderResult(
  result: RenderPlanResult | RenderPromptResult,
  planOverride?: RuntimePlan,
): Record<string, unknown> {
  const plan = planOverride ?? result.plan;

  return {
    traceId: result.traceId,
    html: result.html,
    plan: {
      id: plan.id,
      version: plan.version,
    },
    planDetail: plan,
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

async function normalizePlaygroundPlanInput(
  app: RenderifyApp,
  plan: RuntimePlan,
  options?: {
    promptFallback?: string;
  },
): Promise<RuntimePlan> {
  const promptFromMetadata =
    typeof plan.metadata?.sourcePrompt === "string" &&
    plan.metadata.sourcePrompt.trim().length > 0
      ? plan.metadata.sourcePrompt.trim()
      : undefined;
  const prompt = promptFromMetadata ?? options?.promptFallback ?? "playground";

  return await app.getCodeGenerator().generatePlan({
    prompt,
    llmText: JSON.stringify(plan),
  });
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
): Promise<{
  chunkCount: number;
  eventTypeCounts: Record<string, number>;
  streamErrorMessage?: string;
}> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let chunkCount = 0;
  const eventTypeCounts: Record<string, number> = {};
  let streamErrorMessage: string | undefined;

  try {
    for await (const chunk of app.renderPromptStream(prompt)) {
      const serialized = await serializePromptStreamChunk(chunk);
      chunkCount += 1;
      const type = String(serialized.type ?? "unknown");
      eventTypeCounts[type] = (eventTypeCounts[type] ?? 0) + 1;
      res.write(`${JSON.stringify(serialized)}\n`);
    }
  } catch (error) {
    streamErrorMessage = error instanceof Error ? error.message : String(error);
    res.write(
      `${JSON.stringify({
        type: "error",
        error: streamErrorMessage,
      })}\n`,
    );
    eventTypeCounts.error = (eventTypeCounts.error ?? 0) + 1;
  } finally {
    res.end();
  }

  return {
    chunkCount,
    eventTypeCounts,
    ...(streamErrorMessage ? { streamErrorMessage } : {}),
  };
}

async function serializePromptStreamChunk(
  chunk: RenderPromptStreamChunk,
): Promise<Record<string, unknown>> {
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

interface PlaygroundAutoManifestOptions {
  moduleLoader: JspmModuleLoader;
  requireIntegrity: boolean;
  integrityTimeoutMs: number;
}

async function hydratePlaygroundPlanManifest(
  plan: RuntimePlan,
  options: PlaygroundAutoManifestOptions,
): Promise<RuntimePlan> {
  const bareSpecifiers = await collectRuntimePlanBareSpecifiers(plan);
  if (bareSpecifiers.length === 0) {
    return plan;
  }

  const strippedManifest = stripBareSpecifierManifestEntries(
    plan.moduleManifest,
    bareSpecifiers,
  );
  const planForAutoPin =
    strippedManifest !== plan.moduleManifest
      ? { ...plan, moduleManifest: strippedManifest }
      : plan;
  const autoPinnedPlan = await autoPinRuntimePlanModuleManifest(
    planForAutoPin,
    {
      moduleLoader: options.moduleLoader,
    },
  );

  const nextManifest = { ...(autoPinnedPlan.moduleManifest ?? {}) };
  let changed = false;

  for (const specifier of bareSpecifiers) {
    if (nextManifest[specifier]) {
      continue;
    }

    let resolvedUrl: string;
    try {
      resolvedUrl = options.moduleLoader.resolveSpecifier(specifier);
    } catch {
      continue;
    }

    const descriptor: RuntimeModuleDescriptor = {
      resolvedUrl,
    };

    if (options.requireIntegrity && isHttpUrl(resolvedUrl)) {
      const integrity = await fetchRemoteModuleIntegrity(
        resolvedUrl,
        options.integrityTimeoutMs,
      );
      if (integrity) {
        descriptor.integrity = integrity;
      }
    }

    nextManifest[specifier] = descriptor;
    changed = true;
  }

  if (!changed) {
    return autoPinnedPlan;
  }

  return {
    ...autoPinnedPlan,
    moduleManifest: nextManifest,
  };
}

async function collectRuntimePlanBareSpecifiers(
  plan: RuntimePlan,
): Promise<string[]> {
  const specifiers = new Set<string>();

  for (const specifier of plan.imports ?? []) {
    if (isBareModuleSpecifier(specifier)) {
      specifiers.add(specifier);
    }
  }

  for (const specifier of plan.capabilities?.allowedModules ?? []) {
    if (isBareModuleSpecifier(specifier)) {
      specifiers.add(specifier);
    }
  }

  for (const moduleSpecifier of collectComponentModules(plan.root)) {
    if (isBareModuleSpecifier(moduleSpecifier)) {
      specifiers.add(moduleSpecifier);
    }
  }

  if (plan.source?.code) {
    for (const sourceImport of await collectRuntimeSourceImports(
      plan.source.code,
    )) {
      if (isBareModuleSpecifier(sourceImport)) {
        specifiers.add(sourceImport);
      }
    }
  }

  return [...specifiers];
}

function isBareModuleSpecifier(specifier: string): boolean {
  const trimmed = specifier.trim();
  const normalized = trimmed.toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }

  if (normalized.startsWith("inline://") || normalized === "this-plan-source") {
    return false;
  }

  return (
    !trimmed.startsWith("./") &&
    !trimmed.startsWith("../") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("http://") &&
    !trimmed.startsWith("https://") &&
    !trimmed.startsWith("data:") &&
    !trimmed.startsWith("blob:")
  );
}

function stripBareSpecifierManifestEntries(
  manifest: RuntimePlan["moduleManifest"],
  bareSpecifiers: string[],
): RuntimePlan["moduleManifest"] {
  if (!manifest) {
    return manifest;
  }

  const bareSet = new Set(bareSpecifiers);
  let removed = false;
  const nextManifest: RuntimePlan["moduleManifest"] = {};

  for (const [specifier, descriptor] of Object.entries(manifest)) {
    if (bareSet.has(specifier)) {
      removed = true;
      continue;
    }

    nextManifest[specifier] = descriptor;
  }

  if (!removed) {
    return manifest;
  }

  return Object.keys(nextManifest).length > 0 ? nextManifest : undefined;
}

const PLAYGROUND_SERVER_SAFE_SOURCE_IMPORTS = new Set([
  "preact",
  "preact/hooks",
  "preact/compat",
  "preact/jsx-runtime",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "renderify",
]);

async function shouldSkipPlaygroundServerSourceExecution(
  plan: RuntimePlan,
): Promise<boolean> {
  const source = plan.source;
  if (!source || source.runtime !== "preact") {
    return false;
  }

  const imports = await collectRuntimeSourceImports(source.code);
  if (imports.length === 0) {
    return false;
  }

  for (const specifier of imports) {
    if (!isPlaygroundServerSafeSourceImport(specifier)) {
      return true;
    }
  }

  return false;
}

function isPlaygroundServerSafeSourceImport(specifier: string): boolean {
  const trimmed = specifier.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:")
  ) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (PLAYGROUND_SERVER_SAFE_SOURCE_IMPORTS.has(lower)) {
    return true;
  }

  if (!isHttpUrl(trimmed)) {
    return false;
  }

  return (
    lower.includes("preact") ||
    lower.includes("react/jsx-runtime") ||
    lower.includes("react/jsx-dev-runtime")
  );
}

function createPlaygroundClientOnlyExecutionPlan(
  plan: RuntimePlan,
): RuntimePlan {
  const { source: _source, ...withoutSource } = plan;
  const nextCapabilities = plan.capabilities
    ? {
        ...plan.capabilities,
        domWrite: true,
        allowedModules: [],
      }
    : {
        domWrite: true,
        allowedModules: [],
      };

  return {
    ...withoutSource,
    imports: [],
    capabilities: nextCapabilities,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchRemoteModuleIntegrity(
  url: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const cached = REMOTE_MODULE_INTEGRITY_CACHE.get(url);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const body = await response.arrayBuffer();
    const digest = createHash("sha384")
      .update(Buffer.from(body))
      .digest("base64");
    const integrity = `sha384-${digest}`;
    REMOTE_MODULE_INTEGRITY_CACHE.set(url, integrity);
    return integrity;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function installPlaygroundFetchTracer(input: {
  debugTracer?: PlaygroundDebugTracer;
  llmLog: boolean;
}): () => void {
  const { debugTracer, llmLog } = input;
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return () => {};
  }

  let llmCallId = 1;

  const wrappedFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const method = resolveFetchMethod(input, init);
    const rawUrl = resolveFetchUrl(input);
    const target = normalizeFetchTarget(rawUrl);
    const requestSummary = summarizeFetchRequest(init);
    const llmTarget = isLikelyLlmHttpTarget(rawUrl);
    const llmRequestId = llmTarget ? llmCallId++ : undefined;
    const llmRequestPayload =
      llmLog && llmTarget
        ? buildLlmRequestLogPayload({
            method,
            target,
            init,
          })
        : undefined;
    const llmStreamingRequest = Boolean(
      llmLog &&
        llmTarget &&
        llmRequestPayload &&
        detectStreamingLlmRequest(rawUrl, llmRequestPayload.requestBody),
    );
    const startedAtMs = Date.now();

    debugTracer?.logOutboundStart(method, target, requestSummary);
    if (
      llmLog &&
      llmTarget &&
      llmRequestId !== undefined &&
      llmRequestPayload
    ) {
      printLlmLog(
        `request#${llmRequestId}`,
        method,
        target,
        llmRequestPayload.payload,
      );
    }

    try {
      const response = await originalFetch(input, init);
      debugTracer?.recordOutbound({
        method,
        target,
        statusCode: response.status,
        durationMs: Date.now() - startedAtMs,
        request: requestSummary,
        response: {
          ok: response.ok,
          redirected: response.redirected,
          contentType: response.headers.get("content-type") ?? undefined,
        },
      });
      if (llmLog && llmTarget && llmRequestId !== undefined) {
        void logLlmResponsePayload({
          requestId: llmRequestId,
          method,
          target,
          response,
          durationMs: Date.now() - startedAtMs,
          streaming: llmStreamingRequest,
        });
      }
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugTracer?.recordOutbound({
        method,
        target,
        durationMs: Date.now() - startedAtMs,
        request: requestSummary,
        error: message,
      });
      if (llmLog && llmTarget && llmRequestId !== undefined) {
        printLlmLog(`response#${llmRequestId}`, method, target, {
          durationMs: Date.now() - startedAtMs,
          error: message,
        });
      }
      throw error;
    }
  };

  globalThis.fetch = wrappedFetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function isLikelyLlmHttpTarget(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    return (
      pathname.endsWith("/chat/completions") ||
      pathname.endsWith("/messages") ||
      pathname.endsWith("/api/chat") ||
      pathname.endsWith("/api/generate") ||
      pathname.includes(":generatecontent") ||
      pathname.includes(":streamgeneratecontent")
    );
  } catch {
    const normalized = rawUrl.toLowerCase();
    return (
      normalized.includes("/chat/completions") ||
      normalized.includes("/messages") ||
      normalized.includes("/api/chat") ||
      normalized.includes("/api/generate") ||
      normalized.includes(":generatecontent")
    );
  }
}

function buildLlmRequestLogPayload(input: {
  method: string;
  target: string;
  init?: RequestInit;
}): {
  payload: Record<string, unknown>;
  requestBody?: unknown;
} {
  const headers = extractHeaderEntries(input.init?.headers);
  const requestBody = extractLoggableRequestBody(input.init?.body);
  const payload: Record<string, unknown> = {
    method: input.method,
    target: input.target,
  };

  if (Object.keys(headers).length > 0) {
    payload.headers = headers;
  }
  if (requestBody !== undefined) {
    payload.body = requestBody;
  }

  return {
    payload,
    requestBody,
  };
}

function detectStreamingLlmRequest(
  rawUrl: string,
  requestBody: unknown,
): boolean {
  if (isRecord(requestBody) && requestBody.stream === true) {
    return true;
  }

  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    return (
      pathname.includes(":streamgeneratecontent") ||
      parsed.searchParams.get("alt")?.toLowerCase() === "sse"
    );
  } catch {
    return rawUrl.toLowerCase().includes(":streamgeneratecontent");
  }
}

async function logLlmResponsePayload(input: {
  requestId: number;
  method: string;
  target: string;
  response: Response;
  durationMs: number;
  streaming: boolean;
}): Promise<void> {
  const headerSummary = extractResponseHeaderEntries(input.response.headers);
  const payload: Record<string, unknown> = {
    statusCode: input.response.status,
    ok: input.response.ok,
    durationMs: input.durationMs,
  };

  if (Object.keys(headerSummary).length > 0) {
    payload.headers = headerSummary;
  }

  if (input.streaming) {
    payload.streaming = true;
    printLlmLog(
      `response#${input.requestId}`,
      input.method,
      input.target,
      payload,
    );
    return;
  }

  const responseBody = await extractLoggableResponseBody(input.response);
  if (responseBody !== undefined) {
    payload.body = responseBody;
  }

  printLlmLog(
    `response#${input.requestId}`,
    input.method,
    input.target,
    payload,
  );
}

function printLlmLog(
  stage: string,
  method: string,
  target: string,
  details: Record<string, unknown>,
): void {
  console.log(
    `[playground-llm] ${new Date().toISOString()} ${stage} ${method} ${target} ${safeInlineJson(details, LLM_LOG_INLINE_LIMIT)}`,
  );
}

function extractLoggableRequestBody(body: RequestInit["body"]): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return "";
    }

    if (looksLikeJson(trimmed)) {
      try {
        return redactForLlmLog(JSON.parse(trimmed) as unknown);
      } catch {
        return clampDebugText(trimmed, LLM_LOG_TEXT_LIMIT);
      }
    }

    return clampDebugText(trimmed, LLM_LOG_TEXT_LIMIT);
  }

  if (body instanceof URLSearchParams) {
    return redactForLlmLog(Object.fromEntries(body.entries()));
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    return {
      type: "buffer",
      size: body.byteLength,
    };
  }

  if (body instanceof ArrayBuffer) {
    return {
      type: "arraybuffer",
      size: body.byteLength,
    };
  }

  if (ArrayBuffer.isView(body)) {
    return {
      type: "typedarray",
      size: body.byteLength,
    };
  }

  if (typeof body === "object" && body !== null) {
    return {
      type: String(body.constructor?.name ?? "object"),
    };
  }

  return {
    type: typeof body,
  };
}

async function extractLoggableResponseBody(
  response: Response,
): Promise<unknown> {
  try {
    const text = await response.clone().text();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (contentType.includes("application/json") || looksLikeJson(trimmed)) {
      try {
        return redactForLlmLog(JSON.parse(trimmed) as unknown);
      } catch {
        return clampDebugText(trimmed, LLM_LOG_TEXT_LIMIT);
      }
    }

    return clampDebugText(trimmed, LLM_LOG_TEXT_LIMIT);
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractHeaderEntries(
  headers: RequestInit["headers"],
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const entries: Array<[string, string]> = [];
  if (headers instanceof Headers) {
    entries.push(...headers.entries());
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      entries.push([String(name), String(value)]);
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      entries.push([name, String(value)]);
    }
  }

  const next: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    next[name] = redactHeaderValue(name, rawValue);
  }
  return next;
}

function extractResponseHeaderEntries(
  headers: Headers,
): Record<string, string> {
  const keys = [
    "content-type",
    "content-length",
    "x-request-id",
    "openai-request-id",
    "anthropic-request-id",
  ];
  const next: Record<string, string> = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (value) {
      next[key] = redactHeaderValue(key, value);
    }
  }
  return next;
}

function redactHeaderValue(name: string, value: string): string {
  if (LLM_SENSITIVE_KEY_PATTERN.test(name)) {
    return "[REDACTED]";
  }
  return clampDebugText(value, 400);
}

function redactForLlmLog(value: unknown, keyHint = "", depth = 0): unknown {
  if (depth > 8) {
    return "[MaxDepth]";
  }

  if (typeof value === "string") {
    if (LLM_SENSITIVE_KEY_PATTERN.test(keyHint)) {
      return "[REDACTED]";
    }
    return clampDebugText(value, LLM_LOG_TEXT_LIMIT);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLlmLog(item, keyHint, depth + 1));
  }

  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (LLM_SENSITIVE_KEY_PATTERN.test(key)) {
        next[key] = "[REDACTED]";
      } else {
        next[key] = redactForLlmLog(item, key, depth + 1);
      }
    }
    return next;
  }

  return value;
}

function looksLikeJson(value: string): boolean {
  const firstChar = value[0];
  return firstChar === "{" || firstChar === "[";
}

function resolveFetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method && init.method.trim().length > 0) {
    return init.method.trim().toUpperCase();
  }

  if (
    typeof input === "object" &&
    input !== null &&
    "method" in input &&
    typeof input.method === "string" &&
    input.method.trim().length > 0
  ) {
    return input.method.trim().toUpperCase();
  }

  return "GET";
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  return String(input);
}

function normalizeFetchTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname || "/";
    return `${parsed.host}${path}`;
  } catch {
    return rawUrl;
  }
}

function summarizeFetchRequest(init?: RequestInit): Record<string, unknown> {
  if (!init) {
    return {};
  }

  const body = init.body;
  const bodyInfo = summarizeRequestBody(body);
  const headerKeys = extractHeaderKeys(init.headers);
  const summary: Record<string, unknown> = {};

  if (headerKeys.length > 0) {
    summary.headerKeys = headerKeys;
  }
  if (Object.keys(bodyInfo).length > 0) {
    summary.body = bodyInfo;
  }

  return summary;
}

function summarizeRequestBody(
  body: RequestInit["body"],
): Record<string, unknown> {
  if (body === undefined || body === null) {
    return {};
  }

  if (typeof body === "string") {
    return {
      type: "string",
      size: Buffer.byteLength(body),
      preview: clampDebugText(body),
    };
  }
  if (body instanceof URLSearchParams) {
    return {
      type: "urlsearchparams",
      size: Buffer.byteLength(body.toString()),
    };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    return {
      type: "buffer",
      size: body.byteLength,
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      type: "arraybuffer",
      size: body.byteLength,
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      type: "typedarray",
      size: body.byteLength,
    };
  }
  if (typeof body === "object" && body !== null && "size" in body) {
    return {
      type: String(body.constructor?.name ?? "stream"),
    };
  }

  return {
    type: typeof body,
  };
}

function extractHeaderKeys(headers: RequestInit["headers"]): string[] {
  if (!headers) {
    return [];
  }

  if (headers instanceof Headers) {
    return [...headers.keys()].sort();
  }

  if (Array.isArray(headers)) {
    return headers.map((entry) => String(entry[0]).toLowerCase()).sort();
  }

  return Object.keys(headers)
    .map((item) => item.toLowerCase())
    .sort();
}

function summarizePromptDebugInput(prompt: string): Record<string, unknown> {
  return {
    promptLength: prompt.length,
    promptPreview: clampDebugText(prompt),
  };
}

function summarizePlanDebugInput(plan: RuntimePlan): Record<string, unknown> {
  const importsCount = Array.isArray(plan.imports) ? plan.imports.length : 0;
  const moduleManifestCount = plan.moduleManifest
    ? Object.keys(plan.moduleManifest).length
    : 0;
  const allowedModulesCount = Array.isArray(plan.capabilities?.allowedModules)
    ? plan.capabilities.allowedModules.length
    : 0;

  return {
    planId: plan.id,
    version: plan.version,
    rootType: plan.root.type,
    importsCount,
    moduleManifestCount,
    allowedModulesCount,
    hasSource: Boolean(plan.source),
    sourceRuntime: plan.source?.runtime,
    sourceLanguage: plan.source?.language,
  };
}

function summarizeRenderResultDebugOutput(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const html = typeof payload.html === "string" ? payload.html : "";
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics
    : [];
  const plan = isRecord(payload.plan) ? payload.plan : {};
  const planDetail = isRecord(payload.planDetail) ? payload.planDetail : {};
  const moduleManifest = isRecord(planDetail.moduleManifest)
    ? planDetail.moduleManifest
    : undefined;

  return {
    traceId: payload.traceId,
    planId: plan.id,
    htmlBytes: Buffer.byteLength(html),
    diagnosticsCount: diagnostics.length,
    moduleManifestCount: moduleManifest
      ? Object.keys(moduleManifest).length
      : 0,
  };
}

function clampDebugText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function safeInlineJson(value: unknown, maxLength = 1_400): string {
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxLength) {
      return json;
    }
    return `${json.slice(0, maxLength)}…`;
  } catch (error) {
    return `{"error":"${clampDebugText(String(error))}"}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
