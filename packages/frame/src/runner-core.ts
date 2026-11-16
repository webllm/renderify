/**
 * Runs inside the sandboxed frame. It accepts exactly one MessagePort from its
 * parent window, renders the RuntimePlans and source modules it receives into
 * #renderify-frame-root, and reports results, size changes, actions, and
 * runtime errors back through that port.
 *
 * `runner.js` starts it with Babel for JSX/TSX source; `runner-plan.js` starts
 * it without, for hosts that only render declarative RuntimePlans.
 */
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
  seedPlaygroundBrowserModules,
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

export interface RenderifyFrameRunnerOptions {
  /** Babel standalone; without it, only plans without source can render. */
  babel?: BabelLike;
}

let babel: BabelLike | undefined;
let started = false;
const root = document.getElementById("renderify-frame-root");
let port: MessagePort | undefined;
let latestId = 0;
let activeSession: RuntimeInteractiveSession | undefined;

export function startRenderifyFrameRunner(
  options: RenderifyFrameRunnerOptions = {},
): void {
  if (started) {
    return;
  }
  started = true;
  babel = options.babel;
  if (babel) {
    // The runtime's source transpiler looks Babel up on the global object.
    (globalThis as typeof globalThis & { Babel?: unknown }).Babel = babel;
  }
  window.addEventListener("message", onConnect);
  installActionBridge();
  window.addEventListener("error", (event) => {
    post({
      type: "runtime-error",
      message: event.message || "Uncaught error in rendered content",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    post({ type: "runtime-error", message: describeError(event.reason) });
  });
}

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

// Rendered source asks its host for something with
// `window.renderify.action("save", payload)`; the host decides what is allowed.
function installActionBridge(): void {
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
}

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
      showPlaceholder(root);
      const pinDiagnostics: RuntimeDiagnostic[] = [];
      const pinnedPlan = await autoPinRuntimePlanModuleManifest(
        await seedPlaygroundBrowserModules(plan),
        {
          diagnostics: pinDiagnostics,
          fetchTimeoutMs: 10_000,
          maxConcurrentResolutions: 4,
          maxFailedResolutions: 8,
        },
      );
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
  if (!plan.source) {
    return plan;
  }
  if (!babel) {
    throw new Error(
      "This frame renders declarative RuntimePlans only; use the full runner (runner.js) to render JSX or TSX source",
    );
  }
  if (loopTimeoutMs <= 0) {
    return plan;
  }
  return {
    ...plan,
    source: {
      ...plan.source,
      code: guardSourceLoops(babel, plan.source.code, {
        language: plan.source.language,
        limitMs: loopTimeoutMs,
      }),
    },
  };
}

/**
 * Shows a lightweight loading state while a source render downloads its
 * module graph, which can take seconds on a cold cache. The mount replaces it.
 */
function showPlaceholder(target: HTMLElement): void {
  const placeholder = document.createElement("div");
  placeholder.setAttribute("role", "status");
  placeholder.setAttribute("aria-live", "polite");
  placeholder.dataset.renderifyFramePlaceholder = "";
  placeholder.style.cssText =
    "padding:16px;font:14px/1.4 system-ui,sans-serif;color:#667085;";
  placeholder.textContent = "Loading preview…";
  target.replaceChildren(placeholder);
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
