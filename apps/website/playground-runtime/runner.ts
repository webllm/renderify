import Babel from "@babel/standalone";
import {
  collectRuntimeSourceImports,
  normalizeRuntimePlanCandidate,
  type RuntimeDiagnostic,
  type RuntimePlan,
} from "@renderify/ir";
import {
  autoPinRuntimePlanModuleManifest,
  createTrustedInteractiveSession,
  mountBrowserSourceExecution,
  preparePlaygroundBrowserExecution,
  type RuntimeInteractiveSession,
  unmountBrowserSourceExecution,
} from "@renderify/runtime";

type PlaygroundMode = "jsx" | "plan";

interface PlaygroundRenderRequest {
  type: "render";
  runId: number;
  mode: PlaygroundMode;
  code: string;
}

interface PlaygroundConnectRequest {
  type: "renderify-playground-connect";
}

interface PlaygroundDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

const MAX_SOURCE_BYTES = 120_000;
const RUNTIME_OPTIONS = {
  allowIsolationFallback: false,
  browserSourceSandboxFailClosed: true,
  browserSourceSandboxMode: "none" as const,
  browserSourceSandboxTimeoutMs: 30_000,
  defaultMaxExecutionMs: 30_000,
  enableDependencyPreflight: true,
  enforceModuleManifest: true,
  failOnDependencyPreflightError: true,
  remoteFetchBackoffMs: 150,
  remoteFetchRetries: 2,
  remoteFetchTimeoutMs: 12_000,
  remoteFallbackCdnBases: ["https://esm.sh"],
};

const babelGlobal = globalThis as typeof globalThis & {
  Babel?: typeof Babel;
};
babelGlobal.Babel = Babel;

const root = resolveRoot();

let activePort: MessagePort | undefined;
let activeSession: RuntimeInteractiveSession | undefined;
let latestRunId = 0;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isConnectRequest(event.data) || !event.ports[0]) {
    return;
  }

  activePort?.close();
  activePort = event.ports[0];
  activePort.onmessage = (message: MessageEvent<unknown>) => {
    if (!isRenderRequest(message.data)) {
      return;
    }
    latestRunId = message.data.runId;
    void renderRequest(message.data);
  };
  activePort.start();
  postMessageToHost({ type: "ready" });
});

async function renderRequest(request: PlaygroundRenderRequest): Promise<void> {
  const startedAt = performance.now();

  try {
    assertSourceSize(request.code);
    await disposeActiveRender();
    if (request.runId !== latestRunId) {
      return;
    }

    const plan =
      request.mode === "jsx"
        ? await createSourcePlan(request.code, request.runId)
        : parsePlan(request.code, request.runId);

    const diagnostics: PlaygroundDiagnostic[] = [];
    let framework: "react" | "preact" | "runtime-plan" = "runtime-plan";
    let state: Record<string, unknown> | undefined;

    if (plan.source?.runtime === "preact") {
      const autoPinDiagnostics: RuntimeDiagnostic[] = [];
      const pinnedPlan = await autoPinRuntimePlanModuleManifest(plan, {
        diagnostics: autoPinDiagnostics,
        fetchTimeoutMs: 10_000,
        maxConcurrentResolutions: 4,
        maxFailedResolutions: 8,
      });
      diagnostics.push(...autoPinDiagnostics);
      if (request.runId !== latestRunId) {
        return;
      }

      const prepared = await preparePlaygroundBrowserExecution(pinnedPlan);
      framework = prepared.framework;
      const result = await mountBrowserSourceExecution({
        ...prepared,
        config: {
          runtimeOptions: RUNTIME_OPTIONS,
          securityInitialization: { profile: "trusted" },
        },
        target: root,
      });
      diagnostics.push(...result.diagnostics);
    } else {
      const session = await createTrustedInteractiveSession(plan, {
        autoPinFetchTimeoutMs: 10_000,
        runtimeOptions: RUNTIME_OPTIONS,
        target: root,
      });
      if (request.runId !== latestRunId) {
        await session.terminate();
        return;
      }
      activeSession = session;
      const result = session.getLastResult();
      diagnostics.push(...result.execution.diagnostics);
      state = result.execution.state as Record<string, unknown> | undefined;
    }

    if (request.runId !== latestRunId) {
      return;
    }

    postMessageToHost({
      type: "result",
      runId: request.runId,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      diagnostics,
      framework,
      planId: plan.id,
      state,
    });
  } catch (error) {
    if (request.runId !== latestRunId) {
      return;
    }
    root.replaceChildren();
    postMessageToHost({
      type: "error",
      runId: request.runId,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createSourcePlan(
  code: string,
  runId: number,
): Promise<RuntimePlan> {
  const imports = await collectRuntimeSourceImports(code);

  return {
    specVersion: "runtime-plan/v1",
    id: `website_playground_source_${runId}`,
    version: 1,
    root: {
      type: "element",
      tag: "div",
      children: [],
    },
    imports,
    capabilities: {
      domWrite: true,
      allowedModules: imports,
      maxImports: 400,
      maxExecutionMs: 30_000,
    },
    metadata: {
      sourcePrompt: "Website Playground source editor",
      tags: ["source-module", "jsx", "runtime:preact"],
    },
    source: {
      language: "jsx",
      code,
      exportName: "default",
      runtime: "preact",
    },
  };
}

function parsePlan(code: string, runId: number): RuntimePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const plan = normalizeRuntimePlanCandidate(parsed, {
    fallbackId: `website_playground_plan_${runId}`,
  });
  if (!plan) {
    throw new Error(
      "The document is not a valid RuntimePlan. Check specVersion, root, capabilities, state transitions, and template syntax.",
    );
  }
  return plan;
}

async function disposeActiveRender(): Promise<void> {
  unmountBrowserSourceExecution();
  const session = activeSession;
  activeSession = undefined;
  if (session) {
    await session.terminate();
  }
  root.replaceChildren();
}

function assertSourceSize(code: string): void {
  const byteLength = new TextEncoder().encode(code).byteLength;
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `Editor content is ${byteLength} bytes; the Playground limit is ${MAX_SOURCE_BYTES} bytes.`,
    );
  }
}

function isConnectRequest(value: unknown): value is PlaygroundConnectRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "renderify-playground-connect"
  );
}

function isRenderRequest(value: unknown): value is PlaygroundRenderRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PlaygroundRenderRequest>;
  return (
    candidate.type === "render" &&
    Number.isSafeInteger(candidate.runId) &&
    (candidate.mode === "jsx" || candidate.mode === "plan") &&
    typeof candidate.code === "string"
  );
}

function postMessageToHost(message: Record<string, unknown>): void {
  activePort?.postMessage(message);
}

function resolveRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#renderify-root");
  if (!element) {
    throw new Error("Playground mount target is missing");
  }
  return element;
}
