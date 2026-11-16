import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";
import {
  createRenderifyFrame,
  type RenderifyFrame,
  type RenderifyFrameAction,
  type RenderifyFrameResult,
  type RenderifyFrameTheme,
} from "@renderify/frame";
import {
  RUNTIME_BIND_EVENT_TYPE,
  type RuntimeEvent,
  type RuntimePlan,
  type RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  createInteractiveSession,
  DefaultUIRenderer,
  type RuntimeInteractiveSession,
} from "@renderify/runtime";
import {
  DEFAULT_MCP_PLAN_MAX_BYTES,
  DEFAULT_MCP_SOURCE_MAX_BYTES,
  parseDeclarativeMcpPlan,
  type RenderifyMcpSource,
  type RenderifyMcpViewPayload,
  readRenderifyPayloadFromToolResult,
} from "./plan";

declare const __RENDERIFY_MCP_APP_VERSION__: string;

/**
 * Bound inputs dispatch on every keystroke; their model-context update is
 * sent once typing pauses for this long. Other events flush it immediately.
 */
const BIND_MODEL_CONTEXT_DELAY_MS = 400;

export interface RenderifyMcpViewConfig {
  mountId?: string;
  appName?: string;
  appVersion?: string;
  allowedTools?: readonly string[];
  toolEventPrefix?: string;
  maxPlanBytes?: number;
  enableModelContext?: boolean;
  /** Render `{ source }` tool results in a nested sandboxed frame. */
  sourceMode?: boolean;
  /** CDNs source may import modules from. */
  moduleOrigins?: readonly string[];
  maxSourceBytes?: number;
  /** Id of the data block holding the frame runner code. */
  frameRunnerId?: string;
}

export interface RenderifyMcpViewDependencies {
  app?: App;
  transport?: Transport;
}

export interface RenderifyMcpViewController {
  readonly app: App;
  getSession(): RuntimeInteractiveSession | undefined;
  dispose(): Promise<void>;
}

export async function startRenderifyMcpApp(
  config: RenderifyMcpViewConfig = {},
  dependencies: RenderifyMcpViewDependencies = {},
): Promise<RenderifyMcpViewController> {
  const mount = document.getElementById(config.mountId ?? "renderify-mcp-root");
  if (!mount) {
    throw new Error("Renderify MCP App mount element was not found");
  }

  const maxPlanBytes = config.maxPlanBytes ?? DEFAULT_MCP_PLAN_MAX_BYTES;
  const allowedTools = new Set(config.allowedTools ?? []);
  const toolEventPrefix = config.toolEventPrefix ?? "tool:";
  const ownsApp = dependencies.app === undefined;
  const app =
    dependencies.app ??
    new App(
      {
        name: config.appName ?? "@renderify/mcp-app",
        version: config.appVersion ?? resolveRenderifyMcpAppVersion(),
      },
      {},
      { autoResize: false, strict: true, allowUnsafeEval: false },
    );
  const ui = new DefaultUIRenderer();
  // Source mode renders model-written code in a nested opaque-origin frame,
  // so that code never runs in this window and cannot post to the host as
  // this view. The frame reaches server tools only through `allowedTools`.
  const frameRunner =
    config.sourceMode === true
      ? document.getElementById(
          config.frameRunnerId ?? "renderify-frame-runner",
        )?.textContent || undefined
      : undefined;
  const payloadOptions = {
    maxBytes: maxPlanBytes,
    allowSource: frameRunner !== undefined,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MCP_SOURCE_MAX_BYTES,
  };
  let frame: RenderifyFrame | undefined;

  let session: RuntimeInteractiveSession | undefined;
  let disposed = false;
  let terminated = false;
  let renderGeneration = 0;
  let teardownPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let stopAutoResize: (() => void) | undefined;
  let pendingBindContext: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const cancelPendingBindContext = (): void => {
    if (pendingBindContext !== undefined) {
      clearTimeout(pendingBindContext);
      pendingBindContext = undefined;
    }
  };

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const isInactive = (): boolean => disposed || terminated;
  const stopAutoResizeNotifications = (): void => {
    const stop = stopAutoResize;
    stopAutoResize = undefined;
    try {
      stop?.();
    } catch (error) {
      console.error(
        "[renderify/mcp-app] resize observer cleanup failed",
        error,
      );
    }
  };
  const isCurrentSession = (
    candidate: RuntimeInteractiveSession,
    generation: number,
  ): boolean =>
    !isInactive() && session === candidate && renderGeneration === generation;

  const setStatus = (status: string, message?: string): void => {
    mount.dataset.renderifyStatus = status;
    if (message !== undefined) {
      mount.textContent = message;
    }
  };

  const disposeFrame = (): void => {
    frame?.dispose();
    frame = undefined;
  };

  const releaseRenderedView = async (): Promise<void> => {
    cancelPendingBindContext();
    disposeFrame();
    const activeSession = session;
    session = undefined;
    try {
      if (activeSession) {
        await activeSession.terminate();
      }
    } finally {
      ui.disposeTarget(mount);
      mount.replaceChildren();
    }
  };

  const updateModelContext = async (
    activeSession: RuntimeInteractiveSession,
    event?: RuntimeEvent,
  ): Promise<void> => {
    if (
      config.enableModelContext === false ||
      isInactive() ||
      activeSession !== session
    ) {
      return;
    }
    try {
      await app.updateModelContext({
        structuredContent: {
          renderify: {
            planId: activeSession.plan.id,
            planVersion: activeSession.plan.version,
            state: activeSession.getState() ?? {},
            ...(event ? { lastEvent: event } : {}),
          },
        },
      });
      if (isInactive() || activeSession !== session) {
        return;
      }
      delete mount.dataset.renderifyContextError;
    } catch (error) {
      if (isInactive() || activeSession !== session) {
        return;
      }
      mount.dataset.renderifyContextError = "true";
      console.error("[renderify/mcp-app] model context update failed", error);
    }
  };

  const renderPlan = async (candidate: unknown): Promise<void> => {
    if (isInactive()) {
      return;
    }
    const plan = parseDeclarativeMcpPlan(candidate, { maxBytes: maxPlanBytes });
    const generation = ++renderGeneration;
    disposeFrame();
    const previous = session;
    session = undefined;
    if (previous) {
      await previous.terminate();
    }
    if (isInactive() || renderGeneration !== generation) {
      return;
    }
    // Keep the DOM aligned with the shared renderer's mount-session cache.
    // The next render will reconcile changed markup or reuse identical markup.
    setStatus("loading");

    let created: RuntimeInteractiveSession | undefined;
    created = await createInteractiveSession(plan, {
      ui,
      target: {
        element: mount,
        onRuntimeEvent: async ({ event }) => {
          const activeSession = created;
          if (!activeSession || !isCurrentSession(activeSession, generation)) {
            return;
          }
          if (event.type === RUNTIME_BIND_EVENT_TYPE) {
            // State already holds the new value; report it once typing pauses.
            cancelPendingBindContext();
            pendingBindContext = setTimeout(() => {
              pendingBindContext = undefined;
              void updateModelContext(activeSession, event);
            }, BIND_MODEL_CONTEXT_DELAY_MS);
            return;
          }
          cancelPendingBindContext();
          if (event.type.startsWith(toolEventPrefix)) {
            const toolName = event.type.slice(toolEventPrefix.length);
            if (!allowedTools.has(toolName)) {
              mount.dataset.renderifyToolError = "disallowed";
              console.error(
                `[renderify/mcp-app] runtime event requested disallowed tool: ${toolName}`,
              );
              await updateModelContext(activeSession, event);
              return;
            }
            if (!app.getHostCapabilities()?.serverTools) {
              mount.dataset.renderifyToolError = "unsupported";
              console.error(
                "[renderify/mcp-app] host does not expose server tools to this app",
              );
              await updateModelContext(activeSession, event);
              return;
            }
            try {
              const result = await app.callServerTool({
                name: toolName,
                arguments: event.payload ?? {},
              });
              if (!isCurrentSession(activeSession, generation)) {
                return;
              }
              if (result.isError) {
                mount.dataset.renderifyToolError = "call-failed";
                console.error(
                  "[renderify/mcp-app] server tool returned an error result",
                  extractText(result) ?? "Unknown server tool error",
                );
                await updateModelContext(activeSession, event);
                return;
              }
              delete mount.dataset.renderifyToolError;
              const nextPayload = readRenderifyPayloadFromToolResult(
                result,
                payloadOptions,
              );
              if (nextPayload) {
                await enqueue(async () => {
                  if (!isCurrentSession(activeSession, generation)) {
                    return;
                  }
                  try {
                    await renderPayload(nextPayload);
                  } catch (error) {
                    if (isInactive()) {
                      return;
                    }
                    await releaseRenderedView();
                    if (isInactive()) {
                      return;
                    }
                    setStatus(
                      "error",
                      "This interactive view was rejected by its security policy.",
                    );
                    console.error(
                      "[renderify/mcp-app] server tool result rejected",
                      error,
                    );
                  }
                });
                return;
              }
            } catch (error) {
              if (!isCurrentSession(activeSession, generation)) {
                return;
              }
              mount.dataset.renderifyToolError = "call-failed";
              console.error(
                "[renderify/mcp-app] server tool call failed",
                error,
              );
              await updateModelContext(activeSession, event);
              return;
            }
          }
          await updateModelContext(activeSession, event);
        },
      },
      securityInitialization: {
        profile: "strict",
        overrides: {
          allowedModules: [],
          allowedNetworkHosts: [],
          allowArbitraryNetwork: false,
          allowedExecutionProfiles: ["standard"],
          allowRuntimeSourceModules: false,
          allowPreactSourceRuntime: false,
        },
      },
      runtimeOptions: {
        allowRuntimeSourceExecution: false,
        allowIsolationFallback: false,
        allowArbitraryNetwork: false,
        allowedNetworkHosts: [],
      },
      autoPinLatestModuleManifest: false,
    });
    if (isInactive() || renderGeneration !== generation) {
      await created.terminate();
      ui.disposeTarget(mount);
      mount.replaceChildren();
      return;
    }
    session = created;
    setStatus("ready");
    await updateModelContext(created);
  };

  /**
   * Replaces the previous plan's context: source state stays in the frame,
   * so the model only learns that a source view is showing.
   */
  const reportSourceView = async (
    generation: number,
    framework: RenderifyFrameResult["framework"],
  ): Promise<void> => {
    if (
      config.enableModelContext === false ||
      isInactive() ||
      renderGeneration !== generation
    ) {
      return;
    }
    try {
      await app.updateModelContext({
        structuredContent: { renderify: { view: "source", framework } },
      });
      if (isInactive() || renderGeneration !== generation) {
        return;
      }
      delete mount.dataset.renderifyContextError;
    } catch (error) {
      if (isInactive() || renderGeneration !== generation) {
        return;
      }
      mount.dataset.renderifyContextError = "true";
      console.error("[renderify/mcp-app] model context update failed", error);
    }
  };

  const renderSource = async (source: RenderifyMcpSource): Promise<void> => {
    if (isInactive()) {
      return;
    }
    if (frameRunner === undefined) {
      throw new Error("Source views are disabled for this app");
    }
    const generation = ++renderGeneration;
    cancelPendingBindContext();
    const previous = session;
    session = undefined;
    if (previous) {
      await previous.terminate();
    }
    ui.disposeTarget(mount);
    if (isInactive() || renderGeneration !== generation) {
      return;
    }
    if (!frame) {
      mount.replaceChildren();
      frame = createRenderifyFrame({
        container: mount,
        runnerSource: frameRunner,
        moduleOrigins: config.moduleOrigins ?? [],
        maxInputBytes: payloadOptions.maxSourceBytes,
        allowedActions: [...allowedTools].map(
          (tool) => `${toolEventPrefix}${tool}`,
        ),
        onAction: (action) => {
          void callToolFromSource(action);
        },
        onBlockedAction: (action) => {
          mount.dataset.renderifyToolError = "disallowed";
          console.error(
            `[renderify/mcp-app] source view requested a disallowed action: ${action.type}`,
          );
        },
        theme: frameThemeFromHostContext(app.getHostContext()),
        title: "Interactive view",
      });
    }
    setStatus("loading");
    let result: RenderifyFrameResult;
    try {
      result = await frame.render({
        source: source.code,
        ...(source.language ? { language: source.language } : {}),
        ...(source.runtime ? { runtime: source.runtime } : {}),
      });
    } catch (error) {
      if (isInactive() || renderGeneration !== generation) {
        return;
      }
      // The frame reports compile errors, runtime errors, and timeouts; the
      // view stays usable for the next tool result.
      disposeFrame();
      mount.replaceChildren();
      setStatus("error", "This interactive view could not be rendered.");
      console.error("[renderify/mcp-app] source view failed to render", error);
      return;
    }
    if (isInactive() || renderGeneration !== generation) {
      return;
    }
    mount.dataset.renderifyFramework = result.framework;
    setStatus("ready");
    await reportSourceView(generation, result.framework);
  };

  const renderPayload = async (
    payload: RenderifyMcpViewPayload,
  ): Promise<void> => {
    if ("plan" in payload) {
      await renderPlan(payload.plan);
    } else {
      await renderSource(payload.source);
    }
  };

  /** Calls an allowlisted server tool for an action from the source frame. */
  const callToolFromSource = async (
    action: RenderifyFrameAction,
  ): Promise<void> => {
    const generation = renderGeneration;
    const toolName = action.type.slice(toolEventPrefix.length);
    if (!allowedTools.has(toolName) || isInactive()) {
      return;
    }
    if (!app.getHostCapabilities()?.serverTools) {
      mount.dataset.renderifyToolError = "unsupported";
      return;
    }
    try {
      const result = await app.callServerTool({
        name: toolName,
        arguments: isPlainRecord(action.payload) ? action.payload : {},
      });
      if (isInactive() || renderGeneration !== generation) {
        return;
      }
      if (result.isError) {
        mount.dataset.renderifyToolError = "call-failed";
        console.error(
          "[renderify/mcp-app] server tool returned an error result",
          extractText(result) ?? "Unknown server tool error",
        );
        return;
      }
      delete mount.dataset.renderifyToolError;
      const nextPayload = readRenderifyPayloadFromToolResult(
        result,
        payloadOptions,
      );
      if (nextPayload) {
        await enqueue(async () => {
          if (isInactive() || renderGeneration !== generation) {
            return;
          }
          try {
            await renderPayload(nextPayload);
          } catch (error) {
            if (isInactive()) {
              return;
            }
            await releaseRenderedView();
            setStatus(
              "error",
              "This interactive view was rejected by its security policy.",
            );
            console.error(
              "[renderify/mcp-app] server tool result rejected",
              error,
            );
          }
        });
      }
    } catch (error) {
      if (isInactive() || renderGeneration !== generation) {
        return;
      }
      mount.dataset.renderifyToolError = "call-failed";
      console.error("[renderify/mcp-app] server tool call failed", error);
    }
  };

  const consumeToolResult = async (result: CallToolResult): Promise<void> => {
    if (result.isError) {
      await releaseRenderedView();
      setStatus(
        "error",
        extractText(result) ?? "The tool could not produce a view.",
      );
      return;
    }
    const payload = readRenderifyPayloadFromToolResult(result, payloadOptions);
    if (!payload) {
      await releaseRenderedView();
      setStatus(
        "empty",
        extractText(result) ??
          "This tool result does not contain a Renderify view.",
      );
      return;
    }
    await renderPayload(payload);
  };

  app.ontoolresult = (result) => {
    if (isInactive()) {
      return;
    }
    void enqueue(async () => {
      if (isInactive()) {
        return;
      }
      try {
        await consumeToolResult(result);
      } catch (error) {
        await releaseRenderedView();
        setStatus(
          "error",
          "This interactive view was rejected by its security policy.",
        );
        console.error("[renderify/mcp-app] tool result rejected", error);
      }
    });
  };
  app.ontoolcancelled = ({ reason }) => {
    if (isInactive()) {
      return;
    }
    terminated = true;
    renderGeneration += 1;
    stopAutoResizeNotifications();
    void enqueue(async () => {
      await releaseRenderedView();
      setStatus("cancelled", reason ?? "Tool execution was cancelled.");
    });
  };
  app.onhostcontextchanged = (context) => {
    if (!isInactive()) {
      applyHostContext(context);
      try {
        frame?.setTheme(frameThemeFromHostContext(app.getHostContext()));
      } catch (error) {
        console.error("[renderify/mcp-app] frame theme update failed", error);
      }
    }
  };
  app.onteardown = async () => {
    if (!teardownPromise) {
      if (!terminated) {
        terminated = true;
        renderGeneration += 1;
      }
      stopAutoResizeNotifications();
      teardownPromise = enqueue(async () => {
        await releaseRenderedView();
        setStatus("terminated");
      });
    }
    await teardownPromise;
    return {};
  };

  const transport =
    dependencies.transport ??
    new PostMessageTransport(window.parent, window.parent);
  let connected = false;
  try {
    await app.connect(transport);
    connected = true;
    if (!isInactive()) {
      applyHostContext(app.getHostContext());
      if (ownsApp) {
        stopAutoResize = app.setupSizeChangedNotifications();
      }
      setStatus("connected");
    }
  } catch (error) {
    stopAutoResizeNotifications();
    if (connected) {
      try {
        await app.close();
      } catch (closeError) {
        console.error(
          "[renderify/mcp-app] startup bridge cleanup failed",
          closeError,
        );
      }
    }
    setStatus("error", "Unable to connect this interactive view to its host.");
    throw error;
  }

  return {
    app,
    getSession: () => session,
    dispose: () => {
      if (!disposePromise) {
        disposed = true;
        cancelPendingBindContext();
        stopAutoResizeNotifications();
        disposePromise = (async () => {
          try {
            await enqueue(async () => {
              await releaseRenderedView();
            });
          } finally {
            try {
              await app.close();
            } finally {
              setStatus("disposed");
            }
          }
        })();
      }
      return disposePromise;
    },
  };
}

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (context?.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context?.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
}

const FRAME_THEME_VARIABLE = /^--[A-Za-z0-9_-]{1,64}$/;

/** Maps the host's theme and style variables to what the frame accepts. */
function frameThemeFromHostContext(
  context: McpUiHostContext | undefined,
): RenderifyFrameTheme {
  const theme: RenderifyFrameTheme = {};
  if (context?.theme === "light" || context?.theme === "dark") {
    theme.colorScheme = context.theme;
  }
  const variables: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(
    context?.styles?.variables ?? {},
  )) {
    if (
      count < 128 &&
      typeof value === "string" &&
      value.length <= 512 &&
      FRAME_THEME_VARIABLE.test(name)
    ) {
      variables[name] = value;
      count += 1;
    }
  }
  if (count > 0) {
    theme.variables = variables;
  }
  return theme;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(result: CallToolResult): string | undefined {
  const text = result.content?.find(
    (
      entry,
    ): entry is Extract<(typeof result.content)[number], { type: "text" }> =>
      entry.type === "text",
  );
  return text?.text;
}

export function createRenderifyModelContext(
  plan: RuntimePlan,
  state: RuntimeStateSnapshot = {},
  event?: RuntimeEvent,
): Record<string, unknown> {
  const normalized = parseDeclarativeMcpPlan(plan);
  return {
    renderify: {
      planId: normalized.id,
      planVersion: normalized.version,
      state,
      ...(event ? { lastEvent: event } : {}),
    },
  };
}

function resolveRenderifyMcpAppVersion(): string {
  return typeof __RENDERIFY_MCP_APP_VERSION__ === "string"
    ? __RENDERIFY_MCP_APP_VERSION__
    : "0.0.0";
}
