/**
 * MCP Apps (SEP-1865) protocol constants and types.
 *
 * These mirror the `io.modelcontextprotocol/ui` extension as it stands in the
 * 2026-07-28 release-candidate draft. The extension defines the "envelope":
 * a `ui://` resource rendered in a sandboxed iframe, with bidirectional
 * communication over the MCP JSON-RPC base protocol carried on `postMessage`.
 *
 * Renderify plugs into the one slot the envelope intentionally leaves open:
 * the fully-generative tier, where the model's TSX/JSON arrives as *data* and
 * is executed by a pre-audited runtime shell.
 *
 * Spec source: https://github.com/modelcontextprotocol/ext-apps
 */

/** Reverse-DNS identifier negotiated via the extension capabilities mechanism. */
export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui" as const;

/** URI scheme for predeclared UI resources. */
export const MCP_UI_SCHEME = "ui://" as const;

/**
 * The only content type standardized by the extension today. Renderify serves
 * its shell document under this profile so hosts can statically review it.
 */
export const MCP_UI_HTML_MIME_TYPE = "text/html;profile=mcp-app" as const;

/**
 * Host -> View notifications. Tool input/output reaches the iframe through
 * these channels rather than through the HTML body, which is what lets the
 * shell stay static and pre-auditable while the payload varies per call.
 */
export const MCP_UI_HOST_NOTIFICATIONS = {
  toolInput: "ui/notifications/tool-input",
  toolInputPartial: "ui/notifications/tool-input-partial",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  sizeChanged: "ui/notifications/size-changed",
  hostContextChanged: "ui/notifications/host-context-changed",
  initialized: "ui/notifications/initialized",
  resourceTeardown: "ui/resource-teardown",
} as const;

/** View -> Host request methods the shell may invoke. */
export const MCP_UI_VIEW_METHODS = {
  initialize: "ui/initialize",
  openLink: "ui/open-link",
  downloadFile: "ui/download-file",
  message: "ui/message",
  requestDisplayMode: "ui/request-display-mode",
  updateModelContext: "ui/update-model-context",
} as const;

/** View -> Host notification methods. */
export const MCP_UI_VIEW_NOTIFICATIONS = {
  requestTeardown: "ui/notifications/request-teardown",
  toolsListChanged: "notifications/tools/list_changed",
  message: "notifications/message",
} as const;

/**
 * Base MCP methods the View may call through the host bridge (subject to host
 * approval policy). These are not UI-specific; they are the standard server
 * surface the iframe is allowed to reach.
 */
export const MCP_BASE_METHODS = {
  toolsCall: "tools/call",
  toolsList: "tools/list",
  resourcesRead: "resources/read",
  samplingCreateMessage: "sampling/createMessage",
} as const;

export type McpUiHostNotification =
  (typeof MCP_UI_HOST_NOTIFICATIONS)[keyof typeof MCP_UI_HOST_NOTIFICATIONS];
export type McpUiViewMethod =
  (typeof MCP_UI_VIEW_METHODS)[keyof typeof MCP_UI_VIEW_METHODS];

/**
 * CSP domain allowlists declared on a UI resource's `_meta.ui.csp`. The host
 * derives the iframe's enforced Content-Security-Policy from these.
 */
export interface McpUiCspDomains {
  /** Origins the iframe may open network connections to (connect-src). */
  connectDomains?: string[];
  /** Origins static resources (scripts, styles, images) may load from. */
  resourceDomains?: string[];
  /** Origins permitted for nested iframes (frame-src). */
  frameDomains?: string[];
  /** Allowed base URIs (base-uri). */
  baseUriDomains?: string[];
}

/** `_meta.ui` block attached to a UI resource declaration. */
export interface McpUiResourceMeta {
  csp?: McpUiCspDomains;
  /** Free-form host hints (e.g. preferred display mode). */
  [key: string]: unknown;
}

/** `_meta.ui` block attached to a tool that renders into a UI resource. */
export interface McpUiToolMeta {
  /** `ui://` URI of the resource this tool renders into. */
  resourceUri: string;
  /** Whether the tool output is visible to the model, the app, or both. */
  visibility?: Array<"model" | "app">;
  [key: string]: unknown;
}

/** Build the `ui://<server>/<name>` URI for a resource. */
export function buildUiResourceUri(server: string, name: string): string {
  const cleanServer = server.replace(/^ui:\/\//, "").replace(/\/+$/, "");
  const cleanName = name.replace(/^\/+/, "");
  return `${MCP_UI_SCHEME}${cleanServer}/${cleanName}`;
}

/** True when a string is a syntactically valid `ui://` resource URI. */
export function isUiResourceUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(MCP_UI_SCHEME) &&
    value.length > MCP_UI_SCHEME.length
  );
}
