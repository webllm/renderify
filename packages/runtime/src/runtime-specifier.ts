import type { RuntimeDiagnostic, RuntimeModuleManifest } from "@renderify/ir";
import { FALLBACK_JSPM_CDN_BASE } from "./runtime-defaults";

export type RuntimeSpecifierUsage = "import" | "component" | "source-import";

export interface ResolveRuntimeSpecifierInput {
  specifier: string;
  moduleManifest: RuntimeModuleManifest | undefined;
  diagnostics: RuntimeDiagnostic[];
  usage: RuntimeSpecifierUsage;
  enforceModuleManifest: boolean;
}

export interface ResolveRuntimeSourceSpecifierInput {
  specifier: string;
  moduleManifest: RuntimeModuleManifest | undefined;
  diagnostics: RuntimeDiagnostic[];
  requireManifest?: boolean;
  enforceModuleManifest: boolean;
  moduleLoader?: unknown;
  jspmCdnBase?: string;
}

export function resolveRuntimeSourceSpecifier(
  input: ResolveRuntimeSourceSpecifierInput,
): string {
  const trimmed = input.specifier.trim();
  const manifestResolved = resolveOptionalManifestSpecifier(
    trimmed,
    input.moduleManifest,
  );

  if (manifestResolved && manifestResolved !== trimmed) {
    return resolveSourceSpecifierWithLoader(
      manifestResolved,
      input.moduleLoader,
    );
  }

  if (!shouldRewriteSpecifier(trimmed)) {
    return manifestResolved ?? trimmed;
  }

  const resolvedFromPolicy =
    input.requireManifest !== false
      ? resolveRuntimeSpecifier({
          specifier: trimmed,
          moduleManifest: input.moduleManifest,
          diagnostics: input.diagnostics,
          usage: "source-import",
          enforceModuleManifest: input.enforceModuleManifest,
        })
      : manifestResolved;

  if (!resolvedFromPolicy) {
    return trimmed;
  }

  const loaderResolved = resolveSourceSpecifierWithLoader(
    resolvedFromPolicy,
    input.moduleLoader,
  );
  if (loaderResolved !== resolvedFromPolicy) {
    return loaderResolved;
  }

  const jspmBase = normalizeJspmCdnBase(input.jspmCdnBase);
  if (resolvedFromPolicy.startsWith("npm:")) {
    return `${jspmBase}/npm:${resolvedFromPolicy.slice(4)}`;
  }

  if (isDirectSpecifier(resolvedFromPolicy)) {
    return resolvedFromPolicy;
  }

  if (isBareSpecifier(resolvedFromPolicy)) {
    return `${jspmBase}/npm:${resolvedFromPolicy}`;
  }

  return `${jspmBase}/${resolvedFromPolicy}`;
}

export function resolveRuntimeSpecifier(
  input: ResolveRuntimeSpecifierInput,
): string | undefined {
  if (typeof input.specifier !== "string") {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_MANIFEST_INVALID",
      message: `Invalid ${input.usage} specifier type: ${typeof input.specifier}`,
    });
    return undefined;
  }

  const trimmed = input.specifier.trim();
  if (trimmed.length === 0) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_MANIFEST_INVALID",
      message: `Empty ${input.usage} specifier`,
    });
    return undefined;
  }

  if (isRuntimeSourceIntrinsicSpecifier(trimmed, input.usage)) {
    return trimmed;
  }

  const descriptor = input.moduleManifest?.[trimmed];
  if (descriptor) {
    if (typeof descriptor.resolvedUrl !== "string") {
      input.diagnostics.push({
        level: "error",
        code: "RUNTIME_MANIFEST_INVALID",
        message: `Manifest entry has invalid resolvedUrl for ${trimmed}`,
      });
      return undefined;
    }

    const resolved = descriptor.resolvedUrl.trim();
    if (resolved.length === 0) {
      input.diagnostics.push({
        level: "error",
        code: "RUNTIME_MANIFEST_INVALID",
        message: `Manifest entry has empty resolvedUrl for ${trimmed}`,
      });
      return undefined;
    }

    return resolved;
  }

  if (!input.enforceModuleManifest || isDirectSpecifier(trimmed)) {
    return trimmed;
  }

  input.diagnostics.push({
    level: "error",
    code: "RUNTIME_MANIFEST_MISSING",
    message: `Missing moduleManifest entry for ${input.usage}: ${trimmed}`,
  });
  return undefined;
}

export function resolveSourceImportLoaderCandidate(
  specifier: string,
  moduleManifest: RuntimeModuleManifest | undefined,
  moduleLoader?: unknown,
): string | undefined {
  const manifestResolved = resolveOptionalManifestSpecifier(
    specifier,
    moduleManifest,
  );
  const candidate = (manifestResolved ?? specifier).trim();
  if (candidate.length === 0) {
    return undefined;
  }

  if (
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("/")
  ) {
    return undefined;
  }

  return resolveSourceSpecifierWithLoader(candidate, moduleLoader);
}

export function resolveOptionalManifestSpecifier(
  specifier: string,
  moduleManifest: RuntimeModuleManifest | undefined,
): string | undefined {
  const descriptor = moduleManifest?.[specifier];
  if (!descriptor) {
    return specifier;
  }

  if (typeof descriptor.resolvedUrl !== "string") {
    return undefined;
  }

  const resolved = descriptor.resolvedUrl.trim();
  if (resolved.length === 0) {
    return undefined;
  }

  return resolved;
}

export function resolveSourceSpecifierWithLoader(
  specifier: string,
  loader?: unknown,
): string {
  if (loader && hasResolveSpecifier(loader)) {
    try {
      return loader.resolveSpecifier(specifier);
    } catch {
      return specifier;
    }
  }

  return specifier;
}

export function shouldRewriteSpecifier(specifier: string): boolean {
  return !isDirectSpecifier(specifier);
}

export function isDirectSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("blob:") ||
    specifier.startsWith("data:")
  );
}

export function isHttpUrl(specifier: string): boolean {
  return specifier.startsWith("http://") || specifier.startsWith("https://");
}

export function isBareSpecifier(specifier: string): boolean {
  return !isDirectSpecifier(specifier) && !specifier.startsWith("npm:");
}

function hasResolveSpecifier(loader: unknown): loader is {
  resolveSpecifier(specifier: string): string;
} {
  if (typeof loader !== "object" || loader === null) {
    return false;
  }

  return (
    "resolveSpecifier" in loader &&
    typeof (loader as { resolveSpecifier?: unknown }).resolveSpecifier ===
      "function"
  );
}

function isRuntimeSourceIntrinsicSpecifier(
  specifier: string,
  usage: RuntimeSpecifierUsage,
): boolean {
  if (usage !== "source-import") {
    return false;
  }

  return (
    specifier === "preact/jsx-runtime" ||
    specifier === "react/jsx-runtime" ||
    specifier === "react/jsx-dev-runtime"
  );
}

function normalizeJspmCdnBase(input?: string): string {
  const raw = (input ?? FALLBACK_JSPM_CDN_BASE).trim();
  const withoutTrailingSlash = raw.replace(/\/$/, "");
  if (withoutTrailingSlash.endsWith("/npm")) {
    return withoutTrailingSlash.slice(0, withoutTrailingSlash.length - 4);
  }
  return withoutTrailingSlash;
}
