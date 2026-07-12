/**
 * Content-Security-Policy modelling for the Renderify MCP Apps shell.
 *
 * Two delivery modes, with very different CSP footprints:
 *
 * - `self-contained`: the runtime bundle and (optionally) the transpiler are
 *   inlined into the shell document. No module CDN is contacted *unless* the
 *   generated plan declares bare npm imports. The strictest, host-portable tier.
 *
 * - `declared-domains`: the runtime and generated-code dependencies are fetched
 *   from JSPM/CDN at runtime. This only works if the host honors the resource's
 *   declared CSP domains. It is the convenient tier, and the one most at the
 *   host's mercy — see docs/mcp-apps.md (CSP feasibility findings).
 *
 * `script-src blob:` is required whenever transpiled module code executes,
 * because Renderify materializes each transpiled module as a Blob URL and
 * dynamically `import()`s it. This is a hard requirement of the runtime, not a
 * convenience — a host that forbids `blob:` in `script-src` cannot run the
 * TSX/JSX source path at all (declarative RuntimeNode plans still render).
 */

import type { McpUiCspDomains } from "./protocol";

export type ShellDeliveryMode = "self-contained" | "declared-domains";

/** JSPM origins Renderify resolves bare specifiers through by default. */
export const DEFAULT_JSPM_DOMAINS = [
  "https://ga.jspm.io",
  "https://cdn.jspm.io",
] as const;

/** Fallback module CDNs used by the runtime's multi-CDN retry path. */
export const DEFAULT_FALLBACK_CDN_DOMAINS = [
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
] as const;

/** CDNs the `@babel/standalone` transpiler is typically loaded from. */
export const DEFAULT_TRANSPILER_CDN_DOMAINS = [
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
] as const;

export interface RenderifyCspOptions {
  mode: ShellDeliveryMode;
  /**
   * Origins the runtime may fetch generated-code modules from (JSPM + CDNs).
   * In `self-contained` mode this stays empty unless the plan has bare imports.
   */
  moduleDomains?: string[];
  /**
   * Origins the transpiler script is loaded from. Empty when the transpiler is
   * inlined (self-contained) or when only declarative plans are rendered.
   */
  transpilerDomains?: string[];
  /** Permit `blob:` module execution. Required for the TSX/JSX source path. */
  allowBlobModules?: boolean;
  /** Permit `'unsafe-eval'`. Only needed by transpilers that eval at runtime. */
  allowUnsafeEval?: boolean;
  /** Permit remote (https:) and data: images in generated UI. Default true. */
  allowRemoteImages?: boolean;
}

export type CspDirectives = Record<string, string[]>;

function dedupe(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0);
}

/**
 * Compute the enforced CSP directives for the shell document. This is what the
 * shell embeds via `<meta http-equiv="Content-Security-Policy">` for
 * defense-in-depth and for standalone (non-host) testing. A real MCP host also
 * applies its own CSP derived from the resource's declared domains; the two are
 * intended to agree.
 */
export function buildCspDirectives(
  options: RenderifyCspOptions,
): CspDirectives {
  const allowBlob = options.allowBlobModules !== false;
  const allowImages = options.allowRemoteImages !== false;
  const moduleDomains = options.moduleDomains ?? [];
  const transpilerDomains = options.transpilerDomains ?? [];

  const scriptSrc = dedupe([
    "'self'",
    "'unsafe-inline'",
    ...(allowBlob ? ["blob:"] : []),
    ...(options.allowUnsafeEval ? ["'unsafe-eval'"] : []),
    ...moduleDomains,
    ...transpilerDomains,
  ]);

  const connectSrc = dedupe([...moduleDomains, ...transpilerDomains]);

  const imgSrc = dedupe([
    "'self'",
    "data:",
    ...(allowImages ? ["https:"] : []),
  ]);

  const directives: CspDirectives = {
    "default-src": ["'none'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": imgSrc,
    "font-src": ["'self'", "data:"],
    "connect-src": connectSrc.length > 0 ? connectSrc : ["'none'"],
    "worker-src": allowBlob ? ["blob:"] : ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
  };

  return directives;
}

/** Serialize CSP directives into a header/meta string. */
export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`.trim())
    .join("; ");
}

/** Convenience: directives -> serialized policy in one step. */
export function buildCspString(options: RenderifyCspOptions): string {
  return serializeCsp(buildCspDirectives(options));
}

function toBareOrigins(values: string[]): string[] {
  // The MCP host's `_meta.ui.csp` domain lists are origins, not source
  // expressions; drop keyword sources like 'self' / blob: that belong only in
  // the document-level policy.
  return dedupe(
    values.filter(
      (value) => !value.startsWith("'") && !value.endsWith(":") && value !== "",
    ),
  );
}

/**
 * Translate CSP options into the `_meta.ui.csp` domain allowlists a UI resource
 * declares to the host. The host turns these into the iframe's enforced CSP.
 */
export function buildResourceCspDomains(
  options: RenderifyCspOptions,
): McpUiCspDomains {
  const moduleDomains = options.moduleDomains ?? [];
  const transpilerDomains = options.transpilerDomains ?? [];

  const connectDomains = toBareOrigins(moduleDomains);
  const resourceDomains = toBareOrigins([
    ...moduleDomains,
    ...transpilerDomains,
  ]);

  const csp: McpUiCspDomains = {};
  if (connectDomains.length > 0) {
    csp.connectDomains = connectDomains;
  }
  if (resourceDomains.length > 0) {
    csp.resourceDomains = resourceDomains;
  }
  return csp;
}
