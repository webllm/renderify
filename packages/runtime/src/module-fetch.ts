import { hashStringFNV1a32Base36 } from "@renderify/ir";

export interface RemoteModuleFetchResult {
  url: string;
  code: string;
  contentType: string;
  requestUrl: string;
}

export const DEFAULT_ESM_CDN_BASE = "https://esm.sh";

export function buildRemoteModuleAttemptUrls(
  url: string,
  fallbackCdnBases: string[],
): string[] {
  const candidates = new Set<string>();
  candidates.add(url);

  for (const fallbackBase of fallbackCdnBases) {
    const fallback = toConfiguredFallbackUrl(url, fallbackBase);
    if (fallback) {
      candidates.add(fallback);
    }
  }

  return [...candidates];
}

export function toConfiguredFallbackUrl(
  url: string,
  cdnBase: string,
): string | undefined {
  const normalizedBase = cdnBase.trim().replace(/\/$/, "");
  const specifier = extractJspmNpmSpecifier(url);
  if (!specifier || normalizedBase.length === 0) {
    return undefined;
  }

  if (normalizedBase.includes("esm.sh")) {
    return toEsmFallbackUrl(url, normalizedBase);
  }

  if (normalizedBase.includes("jsdelivr.net")) {
    return `${normalizedBase}/npm/${specifier}`;
  }

  if (normalizedBase.includes("unpkg.com")) {
    const separator = specifier.includes("?") ? "&" : "?";
    return `${normalizedBase}/${specifier}${separator}module`;
  }

  if (normalizedBase.includes("jspm.io")) {
    const root = normalizedBase.endsWith("/npm")
      ? normalizedBase.slice(0, normalizedBase.length - 4)
      : normalizedBase;
    return `${root}/npm:${specifier}`;
  }

  return undefined;
}

export function toEsmFallbackUrl(
  url: string,
  cdnBase = DEFAULT_ESM_CDN_BASE,
): string | undefined {
  const specifier = extractJspmNpmSpecifier(url);
  if (!specifier) {
    return undefined;
  }
  const normalizedBase = cdnBase.trim().replace(/\/$/, "");
  if (normalizedBase.length === 0) {
    return undefined;
  }

  const aliasQuery = [
    "alias=react:preact/compat,react-dom:preact/compat,react-dom/client:preact/compat,react/jsx-runtime:preact/jsx-runtime,react/jsx-dev-runtime:preact/jsx-runtime",
    "target=es2022",
  ].join("&");

  const separator = specifier.includes("?") ? "&" : "?";
  return `${normalizedBase}/${specifier}${separator}${aliasQuery}`;
}

export function extractJspmNpmSpecifier(url: string): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }

  const host = parsedUrl.host.toLowerCase();
  if (!host.endsWith("jspm.io")) {
    return undefined;
  }

  if (!parsedUrl.pathname.startsWith("/npm:")) {
    return undefined;
  }

  const specifier = `${parsedUrl.pathname.slice("/npm:".length)}${
    parsedUrl.search
  }`.trim();
  if (specifier.length === 0) {
    return undefined;
  }

  return specifier;
}

export function isLikelyUnpinnedJspmNpmUrl(url: string): boolean {
  const specifier = extractJspmNpmSpecifier(url);
  if (!specifier) {
    return false;
  }

  return !hasExplicitNpmVersion(specifier);
}

export function isCssModuleResponse(fetched: RemoteModuleFetchResult): boolean {
  return fetched.contentType.includes("text/css") || isCssUrl(fetched.url);
}

export function isJsonModuleResponse(
  fetched: RemoteModuleFetchResult,
): boolean {
  return (
    fetched.contentType.includes("application/json") ||
    fetched.contentType.includes("text/json") ||
    isJsonUrl(fetched.url)
  );
}

export function isJavaScriptModuleResponse(
  fetched: RemoteModuleFetchResult,
): boolean {
  if (isJavaScriptLikeContentType(fetched.contentType)) {
    return true;
  }

  return isJavaScriptUrl(fetched.url);
}

export function isJavaScriptLikeContentType(contentType: string): boolean {
  return (
    contentType.includes("javascript") ||
    contentType.includes("ecmascript") ||
    contentType.includes("typescript") ||
    contentType.includes("module")
  );
}

export function isBinaryLikeContentType(contentType: string): boolean {
  return (
    contentType.includes("application/wasm") ||
    contentType.includes("image/") ||
    contentType.includes("font/")
  );
}

export function isJavaScriptUrl(url: string): boolean {
  const pathname = toUrlPathname(url);
  return /\.(?:m?js|cjs|jsx|ts|tsx)$/i.test(pathname);
}

export function isCssUrl(url: string): boolean {
  const pathname = toUrlPathname(url);
  return /\.css$/i.test(pathname);
}

export function isJsonUrl(url: string): boolean {
  const pathname = toUrlPathname(url);
  return /\.json$/i.test(pathname);
}

export function createCssProxyModuleSource(
  cssText: string,
  sourceUrl: string,
): string {
  const styleId = `renderify-css-${hashStringFNV1a32Base36(sourceUrl)}`;
  const cssLiteral = JSON.stringify(cssText);
  const styleIdLiteral = JSON.stringify(styleId);
  return [
    "const __css = " + cssLiteral + ";",
    "const __styleId = " + styleIdLiteral + ";",
    'if (typeof document !== "undefined") {',
    "  let __style = null;",
    '  const __styles = document.querySelectorAll("style[data-renderify-style-id]");',
    "  for (const __candidate of __styles) {",
    '    if (__candidate.getAttribute("data-renderify-style-id") === __styleId) {',
    "      __style = __candidate;",
    "      break;",
    "    }",
    "  }",
    "  if (!__style) {",
    '    __style = document.createElement("style");',
    '    __style.setAttribute("data-renderify-style-id", __styleId);',
    "    __style.textContent = __css;",
    "    document.head.appendChild(__style);",
    "  }",
    "}",
    "export default __css;",
    "export const cssText = __css;",
  ].join("\n");
}

export function createJsonProxyModuleSource(value: unknown): string {
  return [
    `const __json = ${JSON.stringify(value)};`,
    "export default __json;",
  ].join("\n");
}

export function createTextProxyModuleSource(text: string): string {
  return [
    `const __text = ${JSON.stringify(text)};`,
    "export default __text;",
    "export const text = __text;",
  ].join("\n");
}

export function createUrlProxyModuleSource(url: string): string {
  return [
    `const __assetUrl = ${JSON.stringify(url)};`,
    "export default __assetUrl;",
    "export const assetUrl = __assetUrl;",
  ].join("\n");
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  const externalSignal = options.signal;
  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  if (typeof AbortController === "undefined") {
    return fetch(url);
  }

  const controller = new AbortController();
  const handleExternalAbort = () => {
    controller.abort();
  };
  externalSignal?.addEventListener("abort", handleExternalAbort, {
    once: true,
  });

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
  }
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function toUrlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hasExplicitNpmVersion(specifier: string): boolean {
  const normalized = specifier.trim().split("?")[0] ?? "";
  if (normalized.length === 0) {
    return false;
  }

  if (normalized.startsWith("@")) {
    const segments = normalized.split("/");
    if (segments.length < 2) {
      return false;
    }

    const scopedPackage = segments[1];
    const versionIndex = scopedPackage.lastIndexOf("@");
    return versionIndex > 0 && versionIndex < scopedPackage.length - 1;
  }

  const firstSegment = normalized.split("/")[0];
  const versionIndex = firstSegment.lastIndexOf("@");
  return versionIndex > 0 && versionIndex < firstSegment.length - 1;
}
