/**
 * Assembles the `text/html;profile=mcp-app` shell document.
 *
 * The shell is *static and pre-auditable*: its HTML never changes per tool call.
 * The model's output arrives later as data over `ui/notifications/tool-result`
 * and is executed by the embedded runtime. This is what lets a host review the
 * shell once and then trust every subsequent generative render.
 *
 * Script ordering is decoupled via a ready-promise: the runtime loader resolves
 * `window.__renderifyRuntimeReady`, and the bridge awaits it. So the loader can
 * be a synchronous inline IIFE (self-contained) or a deferred ESM module
 * (declared-domains) without the bridge caring which.
 */

const DEFAULT_MOUNT_ID = "renderify-root";

/** Minimal default styling for the shell frame. */
export const RENDERIFY_SHELL_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #${DEFAULT_MOUNT_ID} { display: block; min-height: 1px; padding: 12px; }
  #${DEFAULT_MOUNT_ID}[data-renderify-error] { color: #b00020; font-family: ui-monospace, monospace; white-space: pre-wrap; }
`;

/**
 * The ready-promise bootstrap. Defined before any runtime loader so both inline
 * and deferred loaders can resolve it. Kept byte-stable so its CSP hash is
 * deterministic.
 */
export const RENDERIFY_READY_BOOTSTRAP = `(function(){var r;window.__renderifyRuntimeReady=new Promise(function(res){r=res;});window.__renderifyResolveRuntime=function(rt){r(rt);};})();`;

export interface ShellInlineScript {
  /** Script body (no <script> wrapper). */
  code: string;
  /** Module vs classic. Defaults to classic. */
  module?: boolean;
  /** Optional importmap JSON to emit immediately before this module script. */
  importmap?: string;
}

export interface AssembleShellOptions {
  /** Serialized Content-Security-Policy for the document `<meta>`. */
  csp: string;
  /** Inline scripts in execution order (bootstrap, runtime loader, bridge). */
  scripts: ShellInlineScript[];
  mountId?: string;
  title?: string;
  styleCss?: string;
  /** Extra `<head>` markup (e.g. a non-inline transpiler script tag). */
  headExtras?: string;
  lang?: string;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderScript(script: ShellInlineScript): string {
  const typeAttr = script.module ? ' type="module"' : "";
  const importmap = script.importmap
    ? `<script type="importmap">${script.importmap}</script>\n`
    : "";
  return `${importmap}<script${typeAttr}>${script.code}</script>`;
}

/** Low-level assembler. Callers supply a fully-formed CSP and inline scripts. */
export function assembleShellDocument(options: AssembleShellOptions): string {
  const mountId = options.mountId ?? DEFAULT_MOUNT_ID;
  const title = options.title ?? "Renderify MCP App";
  const style = options.styleCss ?? RENDERIFY_SHELL_STYLE;
  const lang = options.lang ?? "en";
  const scripts = options.scripts.map(renderScript).join("\n");

  return `<!doctype html>
<html lang="${escapeHtmlAttribute(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(options.csp)}" />
<title>${escapeHtmlAttribute(title)}</title>
<style>${style}</style>
${options.headExtras ?? ""}
</head>
<body>
<div id="${escapeHtmlAttribute(mountId)}" data-renderify-shell="1"></div>
${scripts}
</body>
</html>`;
}

export interface RuntimeLoader {
  /** Self-contained: an IIFE bundle that defines `globalThis.RenderifyRuntime`. */
  inlineBundle?: string;
  /** Declared-domains: ESM specifier to import the runtime namespace from. */
  moduleSpecifier?: string;
  /** Importmap JSON used with `moduleSpecifier`. */
  importmap?: string;
}

/** Build the inline script that resolves the runtime ready-promise. */
export function buildRuntimeLoaderScript(
  loader: RuntimeLoader,
): ShellInlineScript {
  if (loader.inlineBundle) {
    return {
      code: `${loader.inlineBundle}\n;try{window.__renderifyResolveRuntime(globalThis.RenderifyRuntime);}catch(e){console.error("renderify runtime bootstrap failed",e);}`,
      module: false,
    };
  }
  if (loader.moduleSpecifier) {
    return {
      module: true,
      importmap: loader.importmap,
      code: `import * as RenderifyRuntime from ${JSON.stringify(loader.moduleSpecifier)};\nwindow.__renderifyResolveRuntime(RenderifyRuntime);`,
    };
  }
  throw new Error(
    "RuntimeLoader requires either inlineBundle (self-contained) or moduleSpecifier (declared-domains)",
  );
}

export interface BuildShellHtmlOptions {
  /** Serialized CSP for the document. */
  csp: string;
  /** How the runtime gets into the page. */
  runtimeLoader: RuntimeLoader;
  /** The bridge script body (from buildShellBridgeScript). */
  bridgeScript: string;
  mountId?: string;
  title?: string;
  styleCss?: string;
  headExtras?: string;
}

/**
 * Pure, browser-safe shell builder. Produces the complete HTML document given a
 * CSP, a runtime loader, and a bridge script. Hash-based CSP and runtime
 * bundling live in the Node-only orchestrator (`createRenderifyShell`).
 */
export function buildRenderifyShellHtml(
  options: BuildShellHtmlOptions,
): string {
  const scripts: ShellInlineScript[] = [
    { code: RENDERIFY_READY_BOOTSTRAP, module: false },
    buildRuntimeLoaderScript(options.runtimeLoader),
    { code: options.bridgeScript, module: false },
  ];
  return assembleShellDocument({
    csp: options.csp,
    scripts,
    mountId: options.mountId,
    title: options.title,
    styleCss: options.styleCss,
    headExtras: options.headExtras,
  });
}

export { DEFAULT_MOUNT_ID };
