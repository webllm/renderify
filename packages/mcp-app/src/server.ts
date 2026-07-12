import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import {
  type McpUiAppToolConfig,
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

export {
  EXTENSION_ID as MCP_UI_EXTENSION_ID,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import type {
  McpServer,
  RegisteredResource,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { isRuntimePlan, type RuntimePlan } from "@renderify/ir";
import {
  type ParseDeclarativeMcpPlanOptions,
  parseDeclarativeMcpPlan,
  readDeclarativePlanFromToolResult,
} from "./plan";
import {
  type CreateRenderifyShellOptions,
  createRenderifyShell,
  type RenderifyShell,
} from "./shell";

export const RENDERIFY_STRUCTURED_CONTENT_KEY = "renderify";

export interface RenderifyUiPayload {
  plan: RuntimePlan;
}

export interface RenderifyToolResult extends CallToolResult {
  structuredContent: {
    renderify: RenderifyUiPayload;
    [key: string]: unknown;
  };
}

export interface RenderifyToolResultOptions
  extends ParseDeclarativeMcpPlanOptions {
  summary?: string;
  meta?: Record<string, unknown>;
}

export function planPayload(
  plan: RuntimePlan,
  options: ParseDeclarativeMcpPlanOptions = {},
): RenderifyUiPayload {
  return { plan: parseDeclarativeMcpPlan(plan, options) };
}

export function renderifyToolResult(
  payload: RenderifyUiPayload,
  options: RenderifyToolResultOptions = {},
): RenderifyToolResult {
  const normalized = planPayload(payload.plan, options);
  return {
    structuredContent: {
      [RENDERIFY_STRUCTURED_CONTENT_KEY]: normalized,
    },
    content: [
      {
        type: "text",
        text:
          options.summary ??
          `Rendered interactive UI for plan ${normalized.plan.id}.`,
      },
    ],
    ...(options.meta ? { _meta: options.meta } : {}),
  };
}

export function extractRenderifyPlan(
  result: unknown,
  options: ParseDeclarativeMcpPlanOptions = {},
): RuntimePlan | undefined {
  return readDeclarativePlanFromToolResult(result, options);
}

export type RenderifyToolVisibility = "model" | "app";

export type RenderifyToolHandlerExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
>;

export function renderifyToolMeta(
  resourceUri: string,
  options: { visibility?: readonly RenderifyToolVisibility[] } = {},
): { ui: { resourceUri: string; visibility: RenderifyToolVisibility[] } } {
  const uri = normalizeUiUri(resourceUri);
  const visibility = normalizeVisibility(options.visibility);
  return {
    ui: {
      resourceUri: uri,
      visibility,
    },
  };
}

export interface CreateRenderifyUiResourceOptions
  extends CreateRenderifyShellOptions {
  uri: string;
  name: string;
  description?: string;
  prefersBorder?: boolean;
}

export interface RenderifyUiResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: typeof RESOURCE_MIME_TYPE;
  text: string;
  uiMeta: McpUiResourceMeta;
  shell: RenderifyShell;
}

export async function createRenderifyUiResource(
  options: CreateRenderifyUiResourceOptions,
): Promise<RenderifyUiResource> {
  const uri = normalizeUiUri(options.uri);
  const name = options.name.trim();
  if (name.length < 1 || name.length > 200) {
    throw new Error("MCP App resource name must be 1-200 characters");
  }
  const shell = await createRenderifyShell(options);
  const uiMeta: McpUiResourceMeta = {
    csp: shell.uiCsp,
    permissions: {},
    prefersBorder: options.prefersBorder ?? true,
  };

  return {
    uri,
    name,
    ...(options.description ? { description: options.description } : {}),
    mimeType: RESOURCE_MIME_TYPE,
    text: shell.html,
    uiMeta,
    shell,
  };
}

export interface RegisterRenderifyAppOptions
  extends CreateRenderifyUiResourceOptions {
  toolName: string;
  toolTitle?: string;
  toolDescription?: string;
  toolInputSchema?: McpUiAppToolConfig["inputSchema"];
  toolVisibility?: readonly RenderifyToolVisibility[];
  summary?: string | ((plan: RuntimePlan) => string);
  handler: (
    args: unknown,
    extra: RenderifyToolHandlerExtra,
  ) =>
    | RuntimePlan
    | RenderifyUiPayload
    | Promise<RuntimePlan | RenderifyUiPayload>;
}

export interface RegisteredRenderifyApp {
  resource: RenderifyUiResource;
  resourceRegistration: RegisteredResource;
  toolRegistration: RegisteredTool;
}

type RegisterToolWithUnknownInput = (
  server: Pick<McpServer, "registerTool">,
  name: string,
  config: McpUiAppToolConfig,
  callback: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>,
) => RegisteredTool;

const registerToolWithUnknownInput =
  registerAppTool as unknown as RegisterToolWithUnknownInput;

export async function registerRenderifyApp(
  server: Pick<McpServer, "registerResource" | "registerTool">,
  options: RegisterRenderifyAppOptions,
): Promise<RegisteredRenderifyApp> {
  const resource = await createRenderifyUiResource(options);
  const resourceMeta = { ui: resource.uiMeta };
  const resourceRegistration = registerAppResource(
    server,
    resource.name,
    resource.uri,
    {
      mimeType: resource.mimeType,
      ...(resource.description ? { description: resource.description } : {}),
      _meta: resourceMeta,
    },
    async () => ({
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.text,
          _meta: resourceMeta,
        },
      ],
    }),
  );

  const toolName = normalizeToolName(options.toolName);
  const hasInputSchema = options.toolInputSchema !== undefined;
  const toolConfig: McpUiAppToolConfig = {
    ...(options.toolTitle ? { title: options.toolTitle } : {}),
    description:
      options.toolDescription ?? "Render an offline interactive RuntimePlan",
    ...(hasInputSchema ? { inputSchema: options.toolInputSchema } : {}),
    _meta: renderifyToolMeta(resource.uri, {
      visibility: options.toolVisibility,
    }),
  };
  const toolRegistration = registerToolWithUnknownInput(
    server,
    toolName,
    toolConfig,
    async (...callbackArgs: unknown[]) => {
      const args = hasInputSchema ? callbackArgs[0] : {};
      const extra = callbackArgs[hasInputSchema ? 1 : 0];
      const produced = await options.handler(
        args,
        extra as RenderifyToolHandlerExtra,
      );
      const payload = isRuntimePlan(produced)
        ? planPayload(produced, { maxBytes: options.maxPlanBytes })
        : planPayload(produced.plan, { maxBytes: options.maxPlanBytes });
      const summary =
        typeof options.summary === "function"
          ? options.summary(payload.plan)
          : options.summary;
      return renderifyToolResult(payload, {
        maxBytes: options.maxPlanBytes,
        ...(summary ? { summary } : {}),
      });
    },
  );

  return { resource, resourceRegistration, toolRegistration };
}

function normalizeUiUri(value: string): string {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error(`Invalid MCP App resource URI: ${value}`);
  }
  if (
    uri.protocol !== "ui:" ||
    uri.hostname.length === 0 ||
    uri.username.length > 0 ||
    uri.password.length > 0 ||
    uri.search.length > 0 ||
    uri.hash.length > 0
  ) {
    throw new Error(
      "MCP App resource URI must be an absolute ui:// URI without credentials, query, or fragment",
    );
  }
  return uri.href;
}

function normalizeVisibility(
  value: readonly RenderifyToolVisibility[] | undefined,
): RenderifyToolVisibility[] {
  const visibility = [...new Set<RenderifyToolVisibility>(value ?? ["model"])];
  if (
    visibility.length < 1 ||
    visibility.some((entry) => entry !== "model" && entry !== "app")
  ) {
    throw new Error("Tool visibility must contain only model and/or app");
  }
  return visibility;
}

function normalizeToolName(value: string): string {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(value)) {
    throw new Error(`Invalid MCP tool name: ${value}`);
  }
  return value;
}
