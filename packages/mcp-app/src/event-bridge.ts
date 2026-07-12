/**
 * Mapping between Renderify's interactive event/state loop and the MCP Apps
 * View<->Host channel.
 *
 * The shell renders a plan with `createInteractiveSession`, so user interaction
 * produces `RuntimeEvent`s and updated state snapshots. Two things flow back to
 * the host:
 *
 *  1. Model context — after every interaction the latest state snapshot is
 *     reported via `ui/update-model-context`, so the model can reason over what
 *     the user did inside the generated UI.
 *
 *  2. Tool calls — events whose `type` is prefixed (default `tool:`) are
 *     forwarded as `tools/call` requests, letting generated UI drive server
 *     tools. The host remains in control and may require approval.
 */

import type { JsonValue, RuntimeEvent } from "@renderify/ir";

/** Default prefix that marks a RuntimeEvent as a tool invocation. */
export const DEFAULT_TOOL_EVENT_PREFIX = "tool:" as const;

export interface ToolCallIntent {
  name: string;
  arguments: Record<string, JsonValue>;
}

/**
 * If `event.type` is `${prefix}<toolName>`, interpret it as a request to call
 * the server tool `<toolName>` with the event payload as arguments. Returns
 * undefined for ordinary state-only events.
 */
export function toolCallFromEvent(
  event: RuntimeEvent,
  prefix: string = DEFAULT_TOOL_EVENT_PREFIX,
): ToolCallIntent | undefined {
  if (typeof event.type !== "string" || !event.type.startsWith(prefix)) {
    return undefined;
  }
  const name = event.type.slice(prefix.length).trim();
  if (name.length === 0) {
    return undefined;
  }
  return {
    name,
    arguments: event.payload ?? {},
  };
}

export interface ModelContextUpdate {
  planId: string;
  /** Latest state snapshot of the interactive session, if any. */
  state?: Record<string, JsonValue>;
  /** The event that triggered this update, if any. */
  event?: RuntimeEvent;
}

/** Params object for an `ui/update-model-context` request. */
export function buildModelContextParams(update: ModelContextUpdate): {
  context: Record<string, JsonValue>;
} {
  const context: Record<string, JsonValue> = { planId: update.planId };
  if (update.state) {
    context.state = update.state;
  }
  if (update.event) {
    context.lastEvent = {
      type: update.event.type,
      ...(update.event.payload ? { payload: update.event.payload } : {}),
    };
  }
  return { context };
}

/** Configuration handed to the in-iframe bridge as a serializable object. */
export interface ShellBridgeConfig {
  mountId: string;
  securityProfile: "strict" | "balanced" | "trusted" | "relaxed";
  /** Disable JSPM auto-pin in the iframe (self-contained / offline plans). */
  autoPinModules: boolean;
  /** Prefix marking a RuntimeEvent as a tool call. */
  toolEventPrefix: string;
  /** Method/notification names, sourced from protocol.ts to stay in sync. */
  methods: {
    initialize: string;
    updateModelContext: string;
    toolsCall: string;
    toolResult: string;
    toolInput: string;
    resourceTeardown: string;
    requestTeardown: string;
    notifyMessage: string;
  };
  /** Emit diagnostic postMessages and console logs. */
  debug: boolean;
}
