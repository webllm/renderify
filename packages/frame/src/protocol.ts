/**
 * Messages exchanged between a host page and the sandboxed frame runner over
 * a transferred MessagePort. Both sides validate every message: the host
 * treats the frame as untrusted, and the frame only accepts its connection
 * from its parent window.
 */

export const RENDERIFY_FRAME_PROTOCOL = "renderify-frame/1";
export const RENDERIFY_FRAME_CONNECT = "renderify-frame-connect";

export const MAX_ACTION_TYPE_LENGTH = 128;
export const MAX_ACTION_PAYLOAD_BYTES = 64 * 1024;
export const MAX_FRAME_HEIGHT = 100_000;
const MAX_DIAGNOSTICS = 100;
const MAX_TEXT_LENGTH = 4_000;
const ACTION_TYPE_PATTERN = /^[A-Za-z0-9_.:/-]+$/;
const THEME_VARIABLE_PATTERN = /^--[A-Za-z0-9_-]{1,64}$/;
const MAX_THEME_VARIABLES = 128;
const MAX_THEME_VALUE_LENGTH = 512;

export type RenderifyFrameSourceLanguage = "js" | "jsx" | "ts" | "tsx";

/** What to render: model-written source, or a RuntimePlan object. */
export type RenderifyFrameInput =
  | {
      source: string;
      language?: RenderifyFrameSourceLanguage;
      /**
       * `preact` (default) runs React-compatible components with hooks and
       * npm imports from the allowed module CDNs; `renderify` compiles JSX to
       * static RuntimeNodes and needs no network.
       */
      runtime?: "preact" | "renderify";
    }
  | { plan: unknown };

export interface RenderifyFrameDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface RenderifyFrameResult {
  durationMs: number;
  diagnostics: RenderifyFrameDiagnostic[];
  framework: "react" | "preact" | "runtime-plan";
  planId: string;
  state?: Record<string, unknown>;
}

/** A request from rendered content to its host, such as "save" or "tool:search". */
export interface RenderifyFrameAction {
  type: string;
  payload?: unknown;
}

export interface RenderifyFrameTheme {
  /** CSS custom properties applied to the frame's root, e.g. `--accent`. */
  variables?: Record<string, string>;
  colorScheme?: "light" | "dark" | "light dark";
}

export interface RenderifyFrameConnectMessage {
  type: typeof RENDERIFY_FRAME_CONNECT;
  protocol: typeof RENDERIFY_FRAME_PROTOCOL;
}

export type HostToFrameMessage =
  | {
      type: "render";
      id: number;
      input: RenderifyFrameInput;
      loopTimeoutMs: number;
    }
  | { type: "theme"; theme: RenderifyFrameTheme };

export type FrameToHostMessage =
  | { type: "ready"; protocol: string }
  | { type: "rendered"; id: number; result: RenderifyFrameResult }
  | { type: "failed"; id: number; message: string; durationMs: number }
  | { type: "resize"; height: number }
  | { type: "action"; action: RenderifyFrameAction }
  | { type: "runtime-error"; message: string };

export function isRenderifyFrameConnectMessage(
  value: unknown,
): value is RenderifyFrameConnectMessage {
  return (
    isRecord(value) &&
    value.type === RENDERIFY_FRAME_CONNECT &&
    value.protocol === RENDERIFY_FRAME_PROTOCOL
  );
}

/** Validates a message received by the frame from its host. */
export function readHostToFrameMessage(
  value: unknown,
): HostToFrameMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "render") {
    const input = readFrameInput(value.input);
    return Number.isSafeInteger(value.id) &&
      typeof value.loopTimeoutMs === "number" &&
      Number.isFinite(value.loopTimeoutMs) &&
      value.loopTimeoutMs >= 0 &&
      input
      ? {
          type: "render",
          id: value.id as number,
          input,
          loopTimeoutMs: value.loopTimeoutMs,
        }
      : undefined;
  }
  if (value.type === "theme") {
    const theme = readFrameTheme(value.theme);
    return theme ? { type: "theme", theme } : undefined;
  }
  return undefined;
}

/**
 * Validates a message received by the host from the frame. Everything the
 * frame sends is attacker-influenced, so shapes and sizes are bounded here.
 */
export function readFrameToHostMessage(
  value: unknown,
): FrameToHostMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  switch (value.type) {
    case "ready":
      return typeof value.protocol === "string"
        ? { type: "ready", protocol: value.protocol }
        : undefined;
    case "rendered": {
      const result = readFrameResult(value.result);
      return Number.isSafeInteger(value.id) && result
        ? { type: "rendered", id: value.id as number, result }
        : undefined;
    }
    case "failed":
      return Number.isSafeInteger(value.id) &&
        typeof value.message === "string" &&
        typeof value.durationMs === "number" &&
        Number.isFinite(value.durationMs)
        ? {
            type: "failed",
            id: value.id as number,
            message: truncate(value.message),
            durationMs: value.durationMs,
          }
        : undefined;
    case "resize":
      return typeof value.height === "number" &&
        Number.isFinite(value.height) &&
        value.height >= 0 &&
        value.height <= MAX_FRAME_HEIGHT
        ? { type: "resize", height: value.height }
        : undefined;
    case "action": {
      const action = readFrameAction(value.action);
      return action ? { type: "action", action } : undefined;
    }
    case "runtime-error":
      return typeof value.message === "string"
        ? { type: "runtime-error", message: truncate(value.message) }
        : undefined;
    default:
      return undefined;
  }
}

export function readFrameAction(
  value: unknown,
): RenderifyFrameAction | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    value.type.length > MAX_ACTION_TYPE_LENGTH ||
    !ACTION_TYPE_PATTERN.test(value.type)
  ) {
    return undefined;
  }
  if (value.payload === undefined) {
    return { type: value.type };
  }
  const serialized = safeStringify(value.payload);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_ACTION_PAYLOAD_BYTES
  ) {
    return undefined;
  }
  return { type: value.type, payload: JSON.parse(serialized) as unknown };
}

export function readFrameTheme(
  value: unknown,
): RenderifyFrameTheme | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const theme: RenderifyFrameTheme = {};
  if (value.colorScheme !== undefined) {
    if (
      value.colorScheme !== "light" &&
      value.colorScheme !== "dark" &&
      value.colorScheme !== "light dark"
    ) {
      return undefined;
    }
    theme.colorScheme = value.colorScheme;
  }
  if (value.variables !== undefined) {
    if (!isRecord(value.variables)) {
      return undefined;
    }
    const entries = Object.entries(value.variables);
    if (entries.length > MAX_THEME_VARIABLES) {
      return undefined;
    }
    const variables: Record<string, string> = {};
    for (const [name, variable] of entries) {
      if (
        !THEME_VARIABLE_PATTERN.test(name) ||
        typeof variable !== "string" ||
        variable.length > MAX_THEME_VALUE_LENGTH
      ) {
        return undefined;
      }
      variables[name] = variable;
    }
    theme.variables = variables;
  }
  return theme;
}

function readFrameInput(value: unknown): RenderifyFrameInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.source === "string") {
    if (
      (value.language !== undefined &&
        value.language !== "js" &&
        value.language !== "jsx" &&
        value.language !== "ts" &&
        value.language !== "tsx") ||
      (value.runtime !== undefined &&
        value.runtime !== "preact" &&
        value.runtime !== "renderify")
    ) {
      return undefined;
    }
    return {
      source: value.source,
      ...(value.language !== undefined
        ? { language: value.language as RenderifyFrameSourceLanguage }
        : {}),
      ...(value.runtime !== undefined
        ? { runtime: value.runtime as "preact" | "renderify" }
        : {}),
    };
  }
  return Object.hasOwn(value, "plan") ? { plan: value.plan } : undefined;
}

function readFrameResult(value: unknown): RenderifyFrameResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    (value.framework !== "react" &&
      value.framework !== "preact" &&
      value.framework !== "runtime-plan") ||
    typeof value.planId !== "string" ||
    !Array.isArray(value.diagnostics)
  ) {
    return undefined;
  }
  const diagnostics: RenderifyFrameDiagnostic[] = [];
  for (const entry of value.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
    if (
      isRecord(entry) &&
      (entry.level === "info" ||
        entry.level === "warning" ||
        entry.level === "error") &&
      typeof entry.code === "string" &&
      typeof entry.message === "string"
    ) {
      diagnostics.push({
        level: entry.level,
        code: truncate(entry.code),
        message: truncate(entry.message),
      });
    }
  }
  const result: RenderifyFrameResult = {
    durationMs: value.durationMs,
    diagnostics,
    framework: value.framework,
    planId: truncate(value.planId),
  };
  if (isRecord(value.state)) {
    const serialized = safeStringify(value.state);
    if (serialized !== undefined) {
      result.state = JSON.parse(serialized) as Record<string, unknown>;
    }
  }
  return result;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function truncate(value: string): string {
  return value.length > MAX_TEXT_LENGTH
    ? `${value.slice(0, MAX_TEXT_LENGTH)}…`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
