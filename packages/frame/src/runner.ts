/**
 * Runs inside the sandboxed frame. It accepts exactly one MessagePort from its
 * parent window, renders the RuntimePlans and source modules it receives into
 * #renderify-frame-root, and reports results, size changes, actions, and
 * runtime errors back through that port.
 */
// A namespace import keeps `transform` reachable however the bundler
// interprets this CommonJS module's `__esModule` flag.
import * as Babel from "@babel/standalone";
import {
  collectRuntimeSourceImports,
  normalizeRuntimePlanCandidate,
  RUNTIME_BIND_EVENT_TYPE,
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
import { type BabelLike, guardSourceLoops } from "./loop-guard";
import {
  type FrameToHostMessage,
  isRenderifyFrameConnectMessage,
  RENDERIFY_FRAME_PROTOCOL,
  type RenderifyFrameDiagnostic,
  type RenderifyFrameInput,
  type RenderifyFrameResult,
  readFrameAction,
  readHostToFrameMessage,
} from "./protocol";

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

(globalThis as typeof globalThis & { Babel?: unknown }).Babel = Babel;

const root = document.getElementById("renderify-frame-root");
let port: MessagePort | undefined;
let latestId = 0;
let activeSession: RuntimeInteractiveSession | undefined;

function post(message: FrameToHostMessage): void {
  port?.postMessage(message);
}

function onConnect(event: MessageEvent<unknown>): void {
  // Only the embedding page may connect, and only once per document.
  if (
    port ||
    event.source !== window.parent ||
    !isRenderifyFrameConnectMessage(event.data) ||
    !event.ports[0]
  ) {
    return;
  }
  window.removeEventListener("message", onConnect);
  port = event.ports[0];
  port.onmessage = (message: MessageEvent<unknown>) => {
    void handleHostMessage(message.data);
  };
  port.start();
  post({ type: "ready", protocol: RENDERIFY_FRAME_PROTOCOL });
  observeSize();
}

window.addEventListener("message", onConnect);

// Rendered source asks its host for something with
// `window.renderify.action("save", payload)`; the host decides what is allowed.
Object.defineProperty(window, "renderify", {
  value: Object.freeze({
    action(type: unknown, payload?: unknown): boolean {
      const action = readFrameAction({ type, payload });
      if (action) {
        post({ type: "action", action });
      }
      return action !== undefined;
    },
  }),
  configurable: false,
  enumerable: false,
  writable: false,
});

window.addEventListener("error", (event) => {
  post({
    type: "runtime-error",
    message: event.message || "Uncaught error in rendered content",
  });
});
window.addEventListener("unhandledrejection", (event) => {
  post({ type: "runtime-error", message: describeError(event.reason) });
});

async function handleHostMessage(data: unknown): Promise<void> {
  const message = readHostToFrameMessage(data);
  if (!message) {
    return;
  }
  if (message.type === "theme") {
    const style = document.documentElement.style;
    if (message.theme.colorScheme) {
      style.colorScheme = message.theme.colorScheme;
    }
    for (const [name, value] of Object.entries(message.theme.variables ?? {})) {
      style.setProperty(name, value);
    }
    return;
  }
  latestId = message.id;
  await render(message.id, message.input, message.loopTimeoutMs);
}

async function render(
  id: number,
  input: RenderifyFrameInput,
  loopTimeoutMs: number,
): Promise<void> {
  const startedAt = performance.now();
  const elapsed = () => Math.round((performance.now() - startedAt) * 10) / 10;
  try {
    if (!root) {
      throw new Error("The frame document is missing #renderify-frame-root");
    }
    await disposeActiveRender(root);
    if (id !== latestId) {
      return;
    }

    const plan = guardPlanSource(
      "source" in input
        ? await createSourcePlan(input, id)
        : parsePlan(input.plan, id),
      loopTimeoutMs,
    );
    const diagnostics: RenderifyFrameDiagnostic[] = [];
    let framework: RenderifyFrameResult["framework"] = "runtime-plan";
    let state: Record<string, unknown> | undefined;

    if (plan.source?.runtime === "preact") {
      const pinDiagnostics: RuntimeDiagnostic[] = [];
      const pinnedPlan = await autoPinRuntimePlanModuleManifest(plan, {
        diagnostics: pinDiagnostics,
        fetchTimeoutMs: 10_000,
        maxConcurrentResolutions: 4,
        maxFailedResolutions: 8,
      });
      diagnostics.push(...pinDiagnostics);
      if (id !== latestId) {
        return;
      }
      const prepared = await preparePlaygroundBrowserExecution(pinnedPlan);
      framework = prepared.framework;
      const mounted = await mountBrowserSourceExecution({
        ...prepared,
        config: {
          runtimeOptions: RUNTIME_OPTIONS,
          securityInitialization: { profile: "trusted" },
        },
        target: root,
      });
      diagnostics.push(...mounted.diagnostics);
    } else {
      const session = await createTrustedInteractiveSession(plan, {
        autoPinFetchTimeoutMs: 10_000,
        runtimeOptions: RUNTIME_OPTIONS,
        target: {
          element: root,
          onRuntimeEvent: ({ event }) => {
            if (event.type !== RUNTIME_BIND_EVENT_TYPE) {
              const action = readFrameAction({
                type: event.type,
                payload: event.payload,
              });
              if (action) {
                post({ type: "action", action });
              }
            }
          },
        },
      });
      if (id !== latestId) {
        await session.terminate();
        return;
      }
      activeSession = session;
      const result = session.getLastResult();
      diagnostics.push(...result.execution.diagnostics);
      state = result.execution.state as Record<string, unknown> | undefined;
    }

    if (id !== latestId) {
      return;
    }
    post({
      type: "rendered",
      id,
      result: {
        durationMs: elapsed(),
        diagnostics,
        framework,
        planId: plan.id,
        ...(state ? { state } : {}),
      },
    });
  } catch (error) {
    if (id !== latestId) {
      return;
    }
    root?.replaceChildren();
    post({
      type: "failed",
      id,
      message: describeError(error),
      durationMs: elapsed(),
    });
  }
}

async function createSourcePlan(
  input: Extract<RenderifyFrameInput, { source: string }>,
  id: number,
): Promise<RuntimePlan> {
  const imports = await collectRuntimeSourceImports(input.source);
  return {
    specVersion: "runtime-plan/v1",
    id: `renderify_frame_source_${id}`,
    version: 1,
    root: { type: "element", tag: "div", children: [] },
    imports,
    capabilities: {
      domWrite: true,
      allowedModules: imports,
      maxImports: 400,
      maxExecutionMs: 30_000,
    },
    source: {
      language: input.language ?? "jsx",
      code: input.source,
      exportName: "default",
      runtime: input.runtime ?? "preact",
    },
  };
}

function parsePlan(value: unknown, id: number): RuntimePlan {
  const plan = normalizeRuntimePlanCandidate(value, {
    fallbackId: `renderify_frame_plan_${id}`,
  });
  if (!plan) {
    throw new Error(
      "The value is not a valid RuntimePlan. Check specVersion, root, capabilities, state transitions, and template syntax.",
    );
  }
  return plan;
}

function guardPlanSource(
  plan: RuntimePlan,
  loopTimeoutMs: number,
): RuntimePlan {
  if (!plan.source || loopTimeoutMs <= 0) {
    return plan;
  }
  return {
    ...plan,
    source: {
      ...plan.source,
      code: guardSourceLoops(Babel as unknown as BabelLike, plan.source.code, {
        language: plan.source.language,
        limitMs: loopTimeoutMs,
      }),
    },
  };
}

async function disposeActiveRender(target: HTMLElement): Promise<void> {
  unmountBrowserSourceExecution();
  const session = activeSession;
  activeSession = undefined;
  if (session) {
    await session.terminate();
  }
  target.replaceChildren();
}

let reportedHeight = -1;
let sizeFrame = 0;

function observeSize(): void {
  if (!root || typeof ResizeObserver !== "function") {
    return;
  }
  const report = () => {
    sizeFrame = 0;
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height !== reportedHeight) {
      reportedHeight = height;
      post({ type: "resize", height });
    }
  };
  new ResizeObserver(() => {
    if (!sizeFrame) {
      sizeFrame = requestAnimationFrame(report);
    }
  }).observe(root);
  report();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}
