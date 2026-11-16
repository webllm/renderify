import { createHash } from "node:crypto";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import {
  type BundleRenderifyMcpViewOptions,
  bundleRenderifyMcpView,
} from "./bundle";
import { isSafeInlineScriptText } from "./inline-script";
import {
  DEFAULT_MCP_PLAN_MAX_BYTES,
  DEFAULT_MCP_SOURCE_MAX_BYTES,
  MAX_MCP_PLAN_MAX_BYTES,
  MAX_MCP_SOURCE_MAX_BYTES,
} from "./plan";

declare const __RENDERIFY_MCP_APP_VERSION__: string;
declare const __RENDERIFY_MCP_APP_DIR__: string;

export const DEFAULT_MCP_MOUNT_ID = "renderify-mcp-root";
export const RENDERIFY_MCP_FRAME_RUNNER_ID = "renderify-frame-runner";
/** Module CDNs source-mode views may import from by default. */
export const DEFAULT_MCP_SOURCE_MODULE_ORIGINS: readonly string[] =
  Object.freeze([
    "https://ga.jspm.io",
    "https://cdn.jspm.io",
    "https://esm.sh",
  ]);
export const DEFAULT_MCP_TOOL_EVENT_PREFIX = "tool:";

export const RENDERIFY_MCP_SHELL_STYLE = `
:root {
  color-scheme: light dark;
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  background: var(--color-background-primary, transparent);
  color: var(--color-text-primary, CanvasText);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-width: 0; }
body { overflow-wrap: anywhere; }
[data-renderify-mount] { min-height: 1px; }
[data-renderify-status="error"] { color: var(--color-text-danger, #b42318); }
`.trim();

export interface CreateRenderifyShellOptions
  extends BundleRenderifyMcpViewOptions {
  browserBundle?: string;
  mountId?: string;
  title?: string;
  appName?: string;
  appVersion?: string;
  allowedTools?: readonly string[];
  toolEventPrefix?: string;
  maxPlanBytes?: number;
  enableModelContext?: boolean;
  /**
   * Let tools return model-written source as well as plans. The view renders
   * source in a nested opaque-origin frame (`@renderify/frame`), never in its
   * own window, and the frame reaches the server only through `allowedTools`.
   * Opting in adds the frame runner (about 2.6 MB), its hash, `blob:`, and
   * `moduleOrigins` to the view's CSP and declares those origins to the host.
   */
  sourceMode?: boolean;
  /** CDNs source may import npm modules from. @defaultValue JSPM and esm.sh */
  moduleOrigins?: readonly string[];
  /** Largest accepted source, in UTF-8 bytes. @defaultValue 262144 */
  maxSourceBytes?: number;
  /** Frame runner code; defaults to the installed `@renderify/frame/runner.js`. */
  frameRunner?: string;
}

export interface RenderifyShellCspDirectives {
  [directive: string]: readonly string[];
}

export interface RenderifyShell {
  html: string;
  csp: string;
  cspDirectives: RenderifyShellCspDirectives;
  uiCsp: McpUiResourceCsp;
  bundleBytes: number;
  bytes: number;
}

export async function createRenderifyShell(
  options: CreateRenderifyShellOptions = {},
): Promise<RenderifyShell> {
  const mountId = normalizeMountId(options.mountId);
  const bundle =
    options.browserBundle !== undefined
      ? createProvidedBrowserBundle(options.browserBundle)
      : await bundleRenderifyMcpView(options);

  const sourceMode = options.sourceMode === true;
  const moduleOrigins = sourceMode
    ? normalizeModuleOrigins(
        options.moduleOrigins ?? DEFAULT_MCP_SOURCE_MODULE_ORIGINS,
      )
    : [];
  const frameRunner = sourceMode
    ? normalizeFrameRunner(options.frameRunner ?? (await loadFrameRunner()))
    : undefined;

  const config = {
    mountId,
    appName: normalizeLabel(options.appName, "@renderify/mcp-app"),
    appVersion: normalizeLabel(
      options.appVersion,
      resolveRenderifyMcpAppVersion(),
    ),
    allowedTools: normalizeToolNames(options.allowedTools),
    toolEventPrefix: normalizeToolEventPrefix(options.toolEventPrefix),
    maxPlanBytes: normalizeMaxPlanBytes(options.maxPlanBytes),
    enableModelContext: options.enableModelContext !== false,
    ...(sourceMode
      ? {
          sourceMode: true,
          moduleOrigins,
          maxSourceBytes: normalizeMaxSourceBytes(options.maxSourceBytes),
          frameRunnerId: RENDERIFY_MCP_FRAME_RUNNER_ID,
        }
      : {}),
  };
  const bootstrap = buildBootstrapScript(config);
  assertSafeInlineScript(bundle.code, "browser bundle");
  assertSafeInlineScript(bootstrap, "bootstrap");

  const scripts = [bundle.code, bootstrap];
  // The nested source frame inherits this policy, so source mode allows the
  // frame runner by hash, blob: module URLs, and the module CDNs. Nothing
  // else is added: no other origins, no eval, and frames stay unloadable by URL.
  const directives: RenderifyShellCspDirectives = {
    "default-src": ["'none'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "script-src": [
      ...scripts.map((script) => `'sha256-${sha256(script)}'`),
      ...(frameRunner
        ? [`'sha256-${sha256(frameRunner)}'`, "blob:", ...moduleOrigins]
        : []),
    ],
    "style-src": ["'unsafe-inline'", ...moduleOrigins],
    "img-src": frameRunner ? ["data:", "blob:"] : ["data:"],
    "font-src": ["data:"],
    "connect-src": moduleOrigins.length > 0 ? [...moduleOrigins] : ["'none'"],
    "media-src": ["'none'"],
    "frame-src": ["'none'"],
    "worker-src": ["'none'"],
    "form-action": ["'none'"],
  };
  const csp = serializeCsp(directives);
  const title = escapeHtml(normalizeLabel(options.title, "Renderify MCP App"));
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`,
    `<title>${title}</title>`,
    `<style>${RENDERIFY_MCP_SHELL_STYLE}</style>`,
    "</head>",
    "<body>",
    `<main id="${escapeHtmlAttribute(mountId)}" data-renderify-mount aria-live="polite"></main>`,
    // A data block: never executed here, read by the view for the frame.
    ...(frameRunner
      ? [
          `<script type="text/plain" id="${RENDERIFY_MCP_FRAME_RUNNER_ID}">${frameRunner}</script>`,
        ]
      : []),
    ...scripts.map((script) => `<script>${script}</script>`),
    "</body>",
    "</html>",
  ].join("");

  return {
    html,
    csp,
    cspDirectives: directives,
    uiCsp: {
      connectDomains: [...moduleOrigins],
      resourceDomains: [...moduleOrigins],
      frameDomains: [],
      baseUriDomains: [],
    },
    bundleBytes: bundle.bytes,
    bytes: new TextEncoder().encode(html).byteLength,
  };
}

function buildBootstrapScript(config: Record<string, unknown>): string {
  const serialized = serializeInlineJson(config);
  return `Promise.resolve().then(function(){return globalThis.RenderifyMcpApp.startRenderifyMcpApp(${serialized});}).catch(function(error){console.error("[renderify/mcp-app] startup failed",error);var root=document.getElementById(${serializeInlineJson(config.mountId)});if(root){root.dataset.renderifyStatus="error";root.textContent="Unable to start this interactive view.";}});`;
}

function resolveRenderifyMcpAppVersion(): string {
  return typeof __RENDERIFY_MCP_APP_VERSION__ === "string"
    ? __RENDERIFY_MCP_APP_VERSION__
    : "0.0.0";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function serializeCsp(directives: RenderifyShellCspDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");
}

function serializeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

async function loadFrameRunner(): Promise<string> {
  const [{ createRequire }, { readFile }, path] = await Promise.all([
    import("node:module"),
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const directory =
    typeof __RENDERIFY_MCP_APP_DIR__ === "string"
      ? __RENDERIFY_MCP_APP_DIR__
      : typeof __dirname === "string"
        ? __dirname
        : process.cwd();
  const require = createRequire(path.join(directory, "package.json"));
  return readFile(require.resolve("@renderify/frame/runner.js"), "utf8");
}

function normalizeMaxSourceBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MCP_SOURCE_MAX_BYTES;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_MCP_SOURCE_MAX_BYTES
  ) {
    throw new Error(
      `maxSourceBytes must be an integer between 1 and ${MAX_MCP_SOURCE_MAX_BYTES}`,
    );
  }
  return maxBytes;
}

function normalizeFrameRunner(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  // The parser rewrites NULs in the data block, which would break the hash.
  if (normalized.includes("\u0000")) {
    throw new Error("frameRunner must not contain null characters");
  }
  if (normalized.trim().length === 0) {
    throw new Error("frameRunner must not be empty");
  }
  assertSafeInlineScript(normalized, "frame runner");
  return normalized;
}

function normalizeModuleOrigins(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error(`Invalid module origin: ${value}`);
        }
        if (
          url.protocol !== "https:" ||
          url.origin !== value.replace(/\/+$/, "")
        ) {
          throw new Error(
            `Module origins must be bare https origins: ${value}`,
          );
        }
        return url.origin;
      }),
    ),
  ];
}

function assertSafeInlineScript(value: string, label: string): void {
  if (!isSafeInlineScriptText(value)) {
    throw new Error(
      `${label} contains a sequence that would break its inline script`,
    );
  }
}

function normalizeBrowserBundle(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.includes("\u0000")) {
    throw new Error("browserBundle must not contain null characters");
  }
  if (normalized.trim().length === 0) {
    throw new Error("browserBundle must not be empty");
  }
  return normalized;
}

function createProvidedBrowserBundle(value: string): {
  code: string;
  bytes: number;
} {
  const code = normalizeBrowserBundle(value);
  return {
    code,
    bytes: new TextEncoder().encode(code).byteLength,
  };
}

function normalizeMountId(value: string | undefined): string {
  const resolved = value ?? DEFAULT_MCP_MOUNT_ID;
  if (!/^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/.test(resolved)) {
    throw new Error(
      "mountId must be a valid HTML id with at most 128 characters",
    );
  }
  return resolved;
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const resolved = value?.trim() || fallback;
  if (resolved.length > 200) {
    throw new Error("MCP App labels must not exceed 200 characters");
  }
  return resolved;
}

function normalizeToolNames(values: readonly string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(value)) {
      throw new Error(`Invalid allowed MCP tool name: ${value}`);
    }
    unique.add(value);
  }
  return [...unique];
}

function normalizeToolEventPrefix(value: string | undefined): string {
  const resolved = value ?? DEFAULT_MCP_TOOL_EVENT_PREFIX;
  if (resolved.length < 1 || resolved.length > 32 || /\s/.test(resolved)) {
    throw new Error("toolEventPrefix must be 1-32 non-whitespace characters");
  }
  return resolved;
}

function normalizeMaxPlanBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MCP_PLAN_MAX_BYTES;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_MCP_PLAN_MAX_BYTES
  ) {
    throw new Error(
      `maxPlanBytes must be an integer between 1 and ${MAX_MCP_PLAN_MAX_BYTES}`,
    );
  }
  return resolved;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
