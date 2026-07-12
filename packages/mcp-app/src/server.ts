/**
 * Server-side helpers. Framework-agnostic: they produce plain objects you wire
 * into whatever MCP server SDK you use. A thin `registerRenderifyApp` adapter is
 * provided for SDK servers that expose `registerResource` / `registerTool`
 * (e.g. `@modelcontextprotocol/sdk`), but you never have to use it.
 *
 * The contract a tool result carries:
 *   structuredContent.renderify = { plan } | { source, id?, capabilities? }
 * The shell's bridge reads exactly this. That's the whole "code as data" story:
 * the model's UI travels in the tool result; the pre-audited shell executes it.
 */

import type {
  JsonValue,
  RuntimeCapabilities,
  RuntimePlan,
  RuntimeSourceModule,
} from "@renderify/ir";
import {
  buildUiResourceUri,
  MCP_UI_EXTENSION_ID,
  MCP_UI_HTML_MIME_TYPE,
  type McpUiCspDomains,
  type McpUiResourceMeta,
  type McpUiToolMeta,
} from "./protocol";
import {
  type CreateRenderifyShellOptions,
  createRenderifyShell,
} from "./shell";

/** Payload carried in a tool result for the shell to render. */
export type RenderifyUiPayload =
  | { plan: RuntimePlan }
  | {
      source: RuntimeSourceModule;
      id?: string;
      capabilities?: RuntimeCapabilities;
    };

/** Wrap a RuntimePlan as a render payload. */
export function planPayload(plan: RuntimePlan): RenderifyUiPayload {
  return { plan };
}

/** Wrap raw TSX/JSX source as a render payload. */
export function sourcePayload(
  source: RuntimeSourceModule,
  options: { id?: string; capabilities?: RuntimeCapabilities } = {},
): RenderifyUiPayload {
  return { source, id: options.id, capabilities: options.capabilities };
}

export interface RenderifyToolResult {
  structuredContent: { renderify: RenderifyUiPayload } & Record<
    string,
    JsonValue
  >;
  content: Array<{ type: "text"; text: string }>;
  _meta?: Record<string, unknown>;
}

/**
 * Build a tool result that renders `payload` in the shell. The text content is a
 * model-facing summary (hosts that don't support MCP Apps still get something
 * sensible); the structuredContent.renderify block is what the shell consumes.
 */
export function renderifyToolResult(
  payload: RenderifyUiPayload,
  options: { summary?: string; meta?: Record<string, unknown> } = {},
): RenderifyToolResult {
  const summary =
    options.summary ??
    ("plan" in payload
      ? `Rendered interactive UI (plan ${payload.plan.id}).`
      : "Rendered interactive UI from generated source.");
  return {
    structuredContent: {
      renderify: payload as RenderifyUiPayload & Record<string, JsonValue>,
    },
    content: [{ type: "text", text: summary }],
    ...(options.meta ? { _meta: options.meta } : {}),
  };
}

/** Build the `_meta.ui` block to attach to a tool that renders into a resource. */
export function renderifyToolMeta(
  resourceUri: string,
  options: { visibility?: Array<"model" | "app"> } = {},
): { ui: McpUiToolMeta } {
  return {
    ui: {
      resourceUri,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    },
  };
}

export interface RenderifyUiResource {
  /** `ui://` URI of the resource. */
  uri: string;
  /** Human-facing resource name. */
  name: string;
  /** Always `text/html;profile=mcp-app`. */
  mimeType: string;
  /** The shell HTML document. */
  text: string;
  /** `_meta` carrying the extension's `ui` block (CSP domains, etc). */
  _meta: Record<string, unknown>;
  /** The serialized CSP embedded in the shell (for inspection). */
  csp: string;
  /** Contents array shaped for a `resources/read` response. */
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

export interface CreateRenderifyUiResourceOptions
  extends CreateRenderifyShellOptions {
  /** Server segment of the `ui://` URI. */
  server: string;
  /** Resource name segment of the `ui://` URI. */
  name: string;
  /** Optional explicit URI overriding `server`/`name`. */
  uri?: string;
  /** Extra `_meta.ui` fields merged into the resource declaration. */
  uiMeta?: Omit<McpUiResourceMeta, "csp"> & { csp?: McpUiCspDomains };
}

/**
 * Build a registerable UI resource: the shell document plus the `_meta.ui`
 * declaration (including the CSP domains the host should enforce).
 */
export async function createRenderifyUiResource(
  options: CreateRenderifyUiResourceOptions,
): Promise<RenderifyUiResource> {
  const shell = await createRenderifyShell(options);
  const uri = options.uri ?? buildUiResourceUri(options.server, options.name);

  const uiMeta: McpUiResourceMeta = {
    csp: { ...shell.cspDomains, ...(options.uiMeta?.csp ?? {}) },
    ...(options.uiMeta
      ? Object.fromEntries(
          Object.entries(options.uiMeta).filter(([key]) => key !== "csp"),
        )
      : {}),
  };

  return {
    uri,
    name: options.name,
    mimeType: MCP_UI_HTML_MIME_TYPE,
    text: shell.html,
    csp: shell.csp,
    _meta: { [MCP_UI_EXTENSION_ID]: { ui: uiMeta }, ui: uiMeta },
    contents: [{ uri, mimeType: MCP_UI_HTML_MIME_TYPE, text: shell.html }],
  };
}

/** Minimal duck-typed surface of an MCP server SDK (e.g. McpServer). */
export interface RegisterableMcpServer {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    read: (uri: unknown) => unknown,
  ) => unknown;
  registerTool?: (
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
}

export interface RegisterRenderifyAppOptions
  extends CreateRenderifyUiResourceOptions {
  /** Tool name that renders into this resource. */
  toolName: string;
  /** Tool description shown to the model. */
  toolDescription?: string;
  /** Tool input schema (SDK-specific shape, passed through). */
  toolInputSchema?: Record<string, unknown>;
  /** Produce the render payload for a tool call. */
  handler: (args: unknown) => Promise<RenderifyUiPayload> | RenderifyUiPayload;
  /** Tool visibility. */
  visibility?: Array<"model" | "app">;
}

/**
 * Convenience wiring for SDK servers exposing registerResource/registerTool.
 * Registers the shell resource and a tool whose results render into it.
 * Returns the built resource for inspection.
 */
export async function registerRenderifyApp(
  server: RegisterableMcpServer,
  options: RegisterRenderifyAppOptions,
): Promise<RenderifyUiResource> {
  const resource = await createRenderifyUiResource(options);

  if (typeof server.registerResource === "function") {
    server.registerResource(
      options.name,
      resource.uri,
      { mimeType: resource.mimeType, _meta: resource._meta },
      () => ({ contents: resource.contents }),
    );
  }

  if (typeof server.registerTool === "function") {
    server.registerTool(
      options.toolName,
      {
        description: options.toolDescription ?? "Render interactive UI",
        ...(options.toolInputSchema
          ? { inputSchema: options.toolInputSchema }
          : {}),
        _meta: renderifyToolMeta(resource.uri, {
          visibility: options.visibility,
        }),
      },
      async (args: unknown) => {
        const payload = await options.handler(args);
        return renderifyToolResult(payload);
      },
    );
  }

  return resource;
}
