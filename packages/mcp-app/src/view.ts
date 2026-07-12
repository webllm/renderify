import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  RuntimeEvent,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  createInteractiveSession,
  type RuntimeInteractiveSession,
} from "@renderify/runtime";
import {
  DEFAULT_MCP_PLAN_MAX_BYTES,
  parseDeclarativeMcpPlan,
  readDeclarativePlanFromToolResult,
} from "./plan";

declare const __RENDERIFY_MCP_APP_VERSION__: string;

export interface RenderifyMcpViewConfig {
  mountId?: string;
  appName?: string;
  appVersion?: string;
  allowedTools?: readonly string[];
  toolEventPrefix?: string;
  maxPlanBytes?: number;
  enableModelContext?: boolean;
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
  const app =
    dependencies.app ??
    new App(
      {
        name: config.appName ?? "@renderify/mcp-app",
        version: config.appVersion ?? resolveRenderifyMcpAppVersion(),
      },
      {},
      { autoResize: true, strict: true, allowUnsafeEval: false },
    );

  let session: RuntimeInteractiveSession | undefined;
  let disposed = false;
  let terminated = false;
  let renderGeneration = 0;
  let teardownPromise: Promise<void> | undefined;
  let queue = Promise.resolve();

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const isInactive = (): boolean => disposed || terminated;
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
    const previous = session;
    session = undefined;
    if (previous) {
      await previous.terminate();
    }
    if (isInactive() || renderGeneration !== generation) {
      return;
    }
    mount.replaceChildren();
    setStatus("loading");

    let created: RuntimeInteractiveSession | undefined;
    created = await createInteractiveSession(plan, {
      target: {
        element: mount,
        onRuntimeEvent: async ({ event }) => {
          const activeSession = created;
          if (!activeSession || !isCurrentSession(activeSession, generation)) {
            return;
          }
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
              const nextPlan = readDeclarativePlanFromToolResult(result, {
                maxBytes: maxPlanBytes,
              });
              if (nextPlan) {
                await enqueue(async () => {
                  if (!isCurrentSession(activeSession, generation)) {
                    return;
                  }
                  await renderPlan(nextPlan);
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
      return;
    }
    session = created;
    setStatus("ready");
    await updateModelContext(created);
  };

  const consumeToolResult = async (result: CallToolResult): Promise<void> => {
    if (result.isError) {
      setStatus(
        "error",
        extractText(result) ?? "The tool could not produce a view.",
      );
      return;
    }
    const plan = readDeclarativePlanFromToolResult(result, {
      maxBytes: maxPlanBytes,
    });
    if (!plan) {
      setStatus(
        "empty",
        extractText(result) ??
          "This tool result does not contain a Renderify view.",
      );
      return;
    }
    await renderPlan(plan);
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
    void enqueue(async () => {
      if (session) {
        await session.terminate();
        session = undefined;
      }
      setStatus("cancelled", reason ?? "Tool execution was cancelled.");
    });
  };
  app.onhostcontextchanged = (context) => {
    if (!isInactive()) {
      applyHostContext(context);
    }
  };
  app.onteardown = async () => {
    if (!teardownPromise) {
      if (!terminated) {
        terminated = true;
        renderGeneration += 1;
      }
      teardownPromise = enqueue(async () => {
        if (session) {
          await session.terminate();
          session = undefined;
        }
        setStatus("terminated");
      });
    }
    await teardownPromise;
    return {};
  };

  const transport =
    dependencies.transport ??
    new PostMessageTransport(window.parent, window.parent);
  try {
    await app.connect(transport);
    if (!isInactive()) {
      applyHostContext(app.getHostContext());
      setStatus("connected");
    }
  } catch (error) {
    setStatus("error", "Unable to connect this interactive view to its host.");
    throw error;
  }

  return {
    app,
    getSession: () => session,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await enqueue(async () => {
        if (session) {
          await session.terminate();
          session = undefined;
        }
      });
      await app.close();
      setStatus("disposed");
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
