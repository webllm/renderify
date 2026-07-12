/**
 * Node-side orchestrator that produces a ready-to-serve shell document.
 *
 * It is the one place that knows how to:
 *   - choose CSP for the delivery mode (and optionally switch to strict
 *     hash-based `script-src`, dropping `'unsafe-inline'` for hosts that forbid
 *     it),
 *   - bundle the runtime for the self-contained tier,
 *   - bake the bridge config, and
 *   - emit the `_meta.ui.csp` domain lists the host enforces.
 */

import { createHash } from "node:crypto";
import { bundleBrowserRuntime } from "./bundle";
import {
  buildCspDirectives,
  buildResourceCspDomains,
  type CspDirectives,
  type RenderifyCspOptions,
  type ShellDeliveryMode,
  serializeCsp,
} from "./csp";
import {
  DEFAULT_TOOL_EVENT_PREFIX,
  type ShellBridgeConfig,
} from "./event-bridge";
import {
  MCP_BASE_METHODS,
  MCP_UI_HOST_NOTIFICATIONS,
  MCP_UI_VIEW_METHODS,
  MCP_UI_VIEW_NOTIFICATIONS,
  type McpUiCspDomains,
} from "./protocol";
import {
  buildShellBridgeScript,
  type ShellBridgeRuntimeConfig,
} from "./shell-bridge-source";
import {
  assembleShellDocument,
  buildRuntimeLoaderScript,
  DEFAULT_MOUNT_ID,
  RENDERIFY_READY_BOOTSTRAP,
  type RuntimeLoader,
  type ShellInlineScript,
} from "./shell-template";

export type SecurityProfile = "strict" | "balanced" | "trusted" | "relaxed";

export interface CreateRenderifyShellOptions {
  mode?: ShellDeliveryMode;
  /** Security profile applied to every render inside the iframe. */
  securityProfile?: SecurityProfile;
  /** Self-contained: precomputed runtime IIFE bundle. Built on demand if omitted. */
  runtimeBundle?: string;
  /** Self-contained: override the runtime entry passed to esbuild. */
  runtimeEntry?: string;
  /** Self-contained: cwd esbuild resolves the runtime entry from. */
  resolveDir?: string;
  /** Declared-domains: ESM specifier the runtime is imported from. */
  runtimeModuleSpecifier?: string;
  /** Declared-domains: importmap JSON used with the module specifier. */
  importmap?: string;
  /** Origins the runtime may fetch generated-code modules from (JSPM + CDNs). */
  moduleDomains?: string[];
  /** Origins the transpiler is loaded from (empty when inlined or declarative-only). */
  transpilerDomains?: string[];
  /** Extra <head> markup, e.g. a same-origin/CDN @babel/standalone script tag. */
  headExtras?: string;
  /** Bare specifier -> browser-ESM source, injected as blob manifest entries. */
  localModules?: Record<string, string>;
  /** Disable JSPM auto-pin in the iframe (offline self-contained). */
  autoPinModules?: boolean;
  /** Prefix marking a RuntimeEvent as a tool call. Default `tool:`. */
  toolEventPrefix?: string;
  /** Use hash-based CSP (no `'unsafe-inline'`). Recommended for strict hosts. */
  useScriptHashes?: boolean;
  /** Permit `'unsafe-eval'` in CSP (only if a transpiler that evals is used). */
  allowUnsafeEval?: boolean;
  mountId?: string;
  title?: string;
  styleCss?: string;
  debug?: boolean;
}

export interface RenderifyShell {
  /** Full HTML document for the `ui://` resource body. */
  html: string;
  /** Serialized CSP embedded in the document. */
  csp: string;
  /** Parsed CSP directives (for inspection/testing). */
  cspDirectives: CspDirectives;
  /** `_meta.ui.csp` domain lists for the resource declaration. */
  cspDomains: McpUiCspDomains;
  mode: ShellDeliveryMode;
  bytes: number;
}

function sha256Base64(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64");
}

function bridgeConfig(
  options: CreateRenderifyShellOptions,
  mode: ShellDeliveryMode,
): ShellBridgeRuntimeConfig {
  const config: ShellBridgeConfig = {
    mountId: options.mountId ?? DEFAULT_MOUNT_ID,
    securityProfile: options.securityProfile ?? "trusted",
    autoPinModules: options.autoPinModules ?? mode === "declared-domains",
    toolEventPrefix: options.toolEventPrefix ?? DEFAULT_TOOL_EVENT_PREFIX,
    methods: {
      initialize: MCP_UI_VIEW_METHODS.initialize,
      updateModelContext: MCP_UI_VIEW_METHODS.updateModelContext,
      toolsCall: MCP_BASE_METHODS.toolsCall,
      toolResult: MCP_UI_HOST_NOTIFICATIONS.toolResult,
      toolInput: MCP_UI_HOST_NOTIFICATIONS.toolInput,
      resourceTeardown: MCP_UI_HOST_NOTIFICATIONS.resourceTeardown,
      requestTeardown: MCP_UI_VIEW_NOTIFICATIONS.requestTeardown,
      notifyMessage: MCP_UI_VIEW_NOTIFICATIONS.message,
    },
    debug: options.debug ?? false,
  };
  return { ...config, localModules: options.localModules };
}

async function resolveRuntimeLoader(
  options: CreateRenderifyShellOptions,
  mode: ShellDeliveryMode,
): Promise<{ loader: RuntimeLoader; bytes: number }> {
  if (mode === "declared-domains") {
    if (!options.runtimeModuleSpecifier) {
      throw new Error(
        "declared-domains mode requires runtimeModuleSpecifier (and usually importmap)",
      );
    }
    return {
      loader: {
        moduleSpecifier: options.runtimeModuleSpecifier,
        importmap: options.importmap,
      },
      bytes: 0,
    };
  }

  const bundle =
    options.runtimeBundle ??
    (
      await bundleBrowserRuntime({
        runtimeEntry: options.runtimeEntry,
        resolveDir: options.resolveDir,
      })
    ).code;

  return {
    loader: { inlineBundle: bundle },
    bytes: Buffer.byteLength(bundle, "utf8"),
  };
}

/**
 * Build a complete Renderify MCP Apps shell document.
 */
export async function createRenderifyShell(
  options: CreateRenderifyShellOptions = {},
): Promise<RenderifyShell> {
  const mode: ShellDeliveryMode = options.mode ?? "self-contained";
  const { loader, bytes: runtimeBytes } = await resolveRuntimeLoader(
    options,
    mode,
  );

  const bridgeScript = buildShellBridgeScript(bridgeConfig(options, mode));
  const runtimeLoaderScript = buildRuntimeLoaderScript(loader);

  // Ordered inline scripts exactly as they will appear in the document.
  const orderedScripts: ShellInlineScript[] = [
    { code: RENDERIFY_READY_BOOTSTRAP, module: false },
    runtimeLoaderScript,
    { code: bridgeScript, module: false },
  ];

  const cspOptions: RenderifyCspOptions = {
    mode,
    moduleDomains: options.moduleDomains,
    transpilerDomains: options.transpilerDomains,
    allowBlobModules: true,
    allowUnsafeEval: options.allowUnsafeEval,
  };

  const directives = buildCspDirectives(cspOptions);

  if (options.useScriptHashes) {
    const hashes: string[] = [];
    for (const script of orderedScripts) {
      if (script.importmap) {
        hashes.push(`'sha256-${sha256Base64(script.importmap)}'`);
      }
      hashes.push(`'sha256-${sha256Base64(script.code)}'`);
    }
    // Hashes supersede 'unsafe-inline' (ignored by browsers when both present).
    directives["script-src"] = [
      ...hashes,
      ...directives["script-src"].filter((s) => s !== "'unsafe-inline'"),
    ];
  }

  const csp = serializeCsp(directives);

  const html = assembleShellDocument({
    csp,
    scripts: orderedScripts,
    mountId: options.mountId,
    title: options.title,
    styleCss: options.styleCss,
    headExtras: options.headExtras,
  });

  return {
    html,
    csp,
    cspDirectives: directives,
    cspDomains: buildResourceCspDomains(cspOptions),
    mode,
    bytes: html.length + runtimeBytes,
  };
}
