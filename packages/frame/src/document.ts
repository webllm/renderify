/** Module CDNs the runner may load npm packages from by default. */
export const DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS: readonly string[] =
  Object.freeze([
    "https://ga.jspm.io",
    "https://cdn.jspm.io",
    "https://esm.sh",
  ]);

export interface RenderifyFrameDocumentOptions {
  /** Absolute URL of the runner script. Required unless `runnerSource` is set. */
  runnerUrl?: string;
  /**
   * The runner's code, inlined into the document instead of loaded from a
   * URL. Use it where the frame must not fetch scripts, such as inside an MCP
   * App view; an inherited CSP then has to allow this exact script by hash.
   */
  runnerSource?: string;
  /** Subresource Integrity hash for the runner script, e.g. `sha384-...`. */
  runnerIntegrity?: string;
  /** Origins the runner may fetch and execute modules from. */
  moduleOrigins?: readonly string[];
}

export interface RenderifyFrameDocument {
  html: string;
  csp: string;
}

/**
 * Builds the `srcdoc` for a sandboxed frame. The Content Security Policy only
 * lets the document run the runner script and modules from the allowed CDNs;
 * it blocks nested frames, workers, form submission, and other network
 * destinations, so rendered code cannot exfiltrate data except to those
 * origins.
 */
export function createRenderifyFrameDocument(
  options: RenderifyFrameDocumentOptions,
): RenderifyFrameDocument {
  const runnerSource = options.runnerSource;
  if (runnerSource !== undefined) {
    // `</script` would end the element early, and `<!--` with `<script`
    // enters the parser's double-escaped state, where it cannot end at all.
    // The `[<]` classes keep these patterns from containing what they reject
    // when this module is itself inlined.
    if (
      /[<]\/script/i.test(runnerSource) ||
      (/[<]!--/.test(runnerSource) && /[<]script/i.test(runnerSource))
    ) {
      throw new Error(
        "runnerSource contains a sequence that would break its inline script",
      );
    }
  } else if (options.runnerUrl === undefined) {
    throw new Error("Either runnerUrl or runnerSource is required");
  }
  const runnerOrigin =
    runnerSource === undefined ? toOrigin(options.runnerUrl ?? "") : undefined;
  if (runnerSource === undefined && !runnerOrigin) {
    throw new Error("runnerUrl must be an absolute http(s) URL");
  }
  const moduleOrigins = (
    options.moduleOrigins ?? DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS
  ).map((origin) => {
    const normalized = toOrigin(origin);
    if (!normalized || normalized !== origin.replace(/\/+$/, "")) {
      throw new Error(`Invalid module origin: ${origin}`);
    }
    return normalized;
  });
  const scriptSources = unique([
    ...(runnerOrigin ? [runnerOrigin] : []),
    ...moduleOrigins,
  ]).join(" ");
  const moduleSources = moduleOrigins.join(" ");

  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${scriptSources}`.trimEnd(),
    `connect-src blob: ${moduleSources}`.trimEnd(),
    `style-src 'unsafe-inline' ${moduleSources}`.trimEnd(),
    "img-src data: blob: https:",
    "font-src data: https:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const integrity = options.runnerIntegrity
    ? ` integrity="${escapeAttribute(options.runnerIntegrity)}" crossorigin="anonymous"`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
    <style>
      html, body { margin: 0; background: transparent; }
      body { font: 16px/1.5 system-ui, sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      #renderify-frame-root { display: flow-root; }
    </style>
  </head>
  <body>
    <div id="renderify-frame-root"></div>
    ${
      runnerSource === undefined
        ? `<script src="${escapeAttribute(options.runnerUrl ?? "")}"${integrity}></script>`
        : `<script>${runnerSource}</script>`
    }
  </body>
</html>`;

  return { html, csp };
}

function toOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
