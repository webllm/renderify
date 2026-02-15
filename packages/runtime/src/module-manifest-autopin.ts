import {
  collectComponentModules,
  collectRuntimeSourceImports,
  type RuntimeDiagnostic,
  type RuntimeModuleDescriptor,
  type RuntimeModuleManifest,
  type RuntimePlan,
} from "@renderify/ir";
import { JspmModuleLoader } from "./jspm-module-loader";
import type { RuntimeModuleLoader } from "./runtime-manager.types";

const FALLBACK_JSPM_CDN_ROOT = "https://ga.jspm.io";
const FALLBACK_AUTOPIN_FETCH_TIMEOUT_MS = 4000;
const FALLBACK_AUTOPIN_MAX_CONCURRENCY = 4;
const FALLBACK_AUTOPIN_MAX_FAILURES = 8;

interface ParsedBareNpmSpecifier {
  packageName: string;
  version?: string;
  subpath?: string;
}

interface ParsedJspmNpmUrl {
  cdnRoot: string;
  packageName: string;
  version?: string;
  subpath?: string;
}

interface JspmPackageJsonShape {
  exports?: unknown;
  module?: unknown;
  main?: unknown;
}

export interface AutoPinRuntimePlanManifestOptions {
  enabled?: boolean;
  moduleLoader?: RuntimeModuleLoader;
  jspmCdnRoot?: string;
  fetchTimeoutMs?: number;
  maxConcurrentResolutions?: number;
  maxFailedResolutions?: number;
  signal?: AbortSignal;
  diagnostics?: RuntimeDiagnostic[];
}

export async function autoPinRuntimePlanModuleManifest(
  plan: RuntimePlan,
  options: AutoPinRuntimePlanManifestOptions = {},
): Promise<RuntimePlan> {
  if (options.enabled === false) {
    return plan;
  }

  const bareSpecifiers = await collectBareSpecifiers(plan);
  if (bareSpecifiers.length === 0) {
    return plan;
  }

  const nextManifest: RuntimeModuleManifest = {
    ...(plan.moduleManifest ?? {}),
  };

  const resolver = new JspmLatestAutoPinResolver({
    moduleLoader:
      options.moduleLoader ??
      new JspmModuleLoader({ cdnBaseUrl: options.jspmCdnRoot }),
    jspmCdnRoot: options.jspmCdnRoot,
    fetchTimeoutMs: options.fetchTimeoutMs,
    signal: options.signal,
  });

  const pendingSpecifiers = bareSpecifiers.filter(
    (specifier) => !nextManifest[specifier],
  );
  if (pendingSpecifiers.length === 0) {
    return plan;
  }

  const maxConcurrentResolutions = normalizeAutoPinPositiveInteger(
    options.maxConcurrentResolutions,
    FALLBACK_AUTOPIN_MAX_CONCURRENCY,
  );
  const maxFailedResolutions = normalizeAutoPinNonNegativeInteger(
    options.maxFailedResolutions,
    FALLBACK_AUTOPIN_MAX_FAILURES,
  );

  let changed = false;
  let failedResolutions = 0;
  let nextIndex = 0;
  let stoppedByFailureBudget = false;

  const workerCount = Math.min(
    maxConcurrentResolutions,
    pendingSpecifiers.length,
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (stoppedByFailureBudget) {
          return;
        }

        const index = nextIndex;
        nextIndex += 1;
        if (index >= pendingSpecifiers.length) {
          return;
        }

        const specifier = pendingSpecifiers[index];
        try {
          const descriptor = await resolver.resolve(specifier);
          if (!descriptor) {
            continue;
          }
          nextManifest[specifier] = descriptor;
          changed = true;
        } catch (error) {
          failedResolutions += 1;
          options.diagnostics?.push({
            level: "warning",
            code: "RUNTIME_MANIFEST_AUTOPIN_FAILED",
            message: `${specifier}: ${toErrorMessage(error)}`,
          });

          if (
            maxFailedResolutions > 0 &&
            failedResolutions >= maxFailedResolutions
          ) {
            stoppedByFailureBudget = true;
            return;
          }
        }
      }
    }),
  );

  if (stoppedByFailureBudget) {
    options.diagnostics?.push({
      level: "warning",
      code: "RUNTIME_MANIFEST_AUTOPIN_BUDGET_EXCEEDED",
      message: `Stopped manifest auto-pin after ${failedResolutions} failures (maxFailedResolutions=${maxFailedResolutions})`,
    });
  }

  if (!changed) {
    return plan;
  }

  return {
    ...plan,
    moduleManifest: nextManifest,
  };
}

class JspmLatestAutoPinResolver {
  private readonly moduleLoader: RuntimeModuleLoader;
  private readonly fetchTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly fallbackCdnRoot: string;
  private readonly latestVersionCache = new Map<
    string,
    Promise<string | undefined>
  >();
  private readonly packageJsonCache = new Map<
    string,
    Promise<JspmPackageJsonShape | undefined>
  >();

  constructor(options: {
    moduleLoader: RuntimeModuleLoader;
    jspmCdnRoot?: string;
    fetchTimeoutMs?: number;
    signal?: AbortSignal;
  }) {
    this.moduleLoader = options.moduleLoader;
    this.fetchTimeoutMs = Math.max(
      1,
      options.fetchTimeoutMs ?? FALLBACK_AUTOPIN_FETCH_TIMEOUT_MS,
    );
    this.signal = options.signal;
    this.fallbackCdnRoot = normalizeJspmCdnRoot(options.jspmCdnRoot);
  }

  async resolve(
    specifier: string,
  ): Promise<RuntimeModuleDescriptor | undefined> {
    const parsedBare = parseBareNpmSpecifier(specifier);
    if (!parsedBare) {
      return undefined;
    }

    const resolvedByLoader = resolveWithModuleLoader(
      this.moduleLoader,
      specifier,
      this.fallbackCdnRoot,
    );
    const parsedFromUrl = parseJspmNpmUrl(resolvedByLoader);

    if (!parsedFromUrl) {
      return {
        resolvedUrl: resolvedByLoader,
        ...(parsedBare.version ? { version: parsedBare.version } : {}),
      };
    }

    const packageName = parsedFromUrl.packageName || parsedBare.packageName;
    const subpath =
      parsedBare.subpath !== undefined
        ? parsedBare.subpath
        : parsedFromUrl.subpath;

    const version =
      parsedBare.version ??
      parsedFromUrl.version ??
      (await this.resolveLatestVersion(parsedFromUrl.cdnRoot, packageName));

    if (!version) {
      return {
        resolvedUrl: resolvedByLoader,
      };
    }

    const entryPath = await this.resolvePackageEntryPath(
      parsedFromUrl.cdnRoot,
      packageName,
      version,
      subpath,
    );

    const pinnedUrl = `${parsedFromUrl.cdnRoot}/npm:${packageName}@${version}${entryPath}`;

    return {
      resolvedUrl: pinnedUrl,
      version,
    };
  }

  private async resolveLatestVersion(
    cdnRoot: string,
    packageName: string,
  ): Promise<string | undefined> {
    const cacheKey = `${cdnRoot}::${packageName}`;
    const cached = this.latestVersionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const loading = (async () => {
      const response = await this.fetchJsonOrText(
        `${cdnRoot}/npm:${packageName}`,
        false,
      );
      const text = String(response).trim();
      return text.length > 0 ? text : undefined;
    })();

    this.latestVersionCache.set(cacheKey, loading);
    return loading;
  }

  private async resolvePackageEntryPath(
    cdnRoot: string,
    packageName: string,
    version: string,
    subpath: string | undefined,
  ): Promise<string> {
    const packageJson = await this.fetchPackageJson(
      cdnRoot,
      packageName,
      version,
    );

    if (subpath && subpath.length > 0) {
      const fromExports = resolveSubpathEntryFromPackageJson(
        packageJson,
        subpath,
      );
      if (fromExports) {
        return fromExports;
      }

      const normalizedSubpath = subpath.replace(/^\/+/, "");
      return normalizedSubpath.includes(".")
        ? `/${normalizedSubpath}`
        : `/${normalizedSubpath}.js`;
    }

    const rootEntry = resolveRootEntryFromPackageJson(packageJson);
    return rootEntry ?? "/index.js";
  }

  private async fetchPackageJson(
    cdnRoot: string,
    packageName: string,
    version: string,
  ): Promise<JspmPackageJsonShape | undefined> {
    const cacheKey = `${cdnRoot}::${packageName}@${version}`;
    const cached = this.packageJsonCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const loading = this.fetchJsonOrText(
      `${cdnRoot}/npm:${packageName}@${version}/package.json`,
      true,
    ).then((value) =>
      isRecord(value) ? (value as JspmPackageJsonShape) : undefined,
    );

    this.packageJsonCache.set(cacheKey, loading);
    return loading;
  }

  private async fetchJsonOrText(
    url: string,
    parseJson: boolean,
  ): Promise<unknown> {
    const scope = createTimeoutAbortScope(this.fetchTimeoutMs, this.signal);
    try {
      const response = await fetch(url, {
        signal: scope.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (parseJson) {
        return response.json();
      }

      return response.text();
    } finally {
      scope.release();
    }
  }
}

async function collectBareSpecifiers(plan: RuntimePlan): Promise<string[]> {
  const collected = new Set<string>();

  for (const specifier of plan.imports ?? []) {
    if (isBareSpecifierForManifest(specifier)) {
      collected.add(specifier);
    }
  }

  for (const specifier of collectComponentModules(plan.root)) {
    if (isBareSpecifierForManifest(specifier)) {
      collected.add(specifier);
    }
  }

  for (const specifier of plan.capabilities?.allowedModules ?? []) {
    if (isBareSpecifierForManifest(specifier)) {
      collected.add(specifier);
    }
  }

  if (plan.source?.code) {
    const sourceImports = await collectRuntimeSourceImports(plan.source.code);
    for (const specifier of sourceImports) {
      if (isBareSpecifierForManifest(specifier)) {
        collected.add(specifier);
      }
    }
  }

  return [...collected];
}

function isBareSpecifierForManifest(specifier: string): boolean {
  const trimmed = specifier.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("./") &&
    !trimmed.startsWith("../") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("http://") &&
    !trimmed.startsWith("https://") &&
    !trimmed.startsWith("data:") &&
    !trimmed.startsWith("blob:") &&
    !trimmed.startsWith("npm:") &&
    !trimmed.startsWith("node:")
  );
}

function parseBareNpmSpecifier(
  specifier: string,
): ParsedBareNpmSpecifier | undefined {
  const trimmed = specifier.trim();
  if (!isBareSpecifierForManifest(trimmed)) {
    return undefined;
  }

  if (trimmed.startsWith("@")) {
    const segments = trimmed.split("/");
    if (segments.length < 2) {
      return undefined;
    }

    const scope = segments[0];
    const packageWithVersion = segments[1];
    const versionIndex = packageWithVersion.lastIndexOf("@");
    const hasVersion = versionIndex > 0;
    const packageName = hasVersion
      ? `${scope}/${packageWithVersion.slice(0, versionIndex)}`
      : `${scope}/${packageWithVersion}`;
    const version = hasVersion
      ? packageWithVersion.slice(versionIndex + 1)
      : undefined;
    const subpath =
      segments.length > 2 ? segments.slice(2).join("/") : undefined;

    return {
      packageName,
      ...(version ? { version } : {}),
      ...(subpath ? { subpath } : {}),
    };
  }

  const [firstSegment, ...restSegments] = trimmed.split("/");
  if (!firstSegment) {
    return undefined;
  }

  const versionIndex = firstSegment.lastIndexOf("@");
  const hasVersion = versionIndex > 0;
  const packageName = hasVersion
    ? firstSegment.slice(0, versionIndex)
    : firstSegment;
  const version = hasVersion ? firstSegment.slice(versionIndex + 1) : undefined;
  const subpath = restSegments.length > 0 ? restSegments.join("/") : undefined;

  return {
    packageName,
    ...(version ? { version } : {}),
    ...(subpath ? { subpath } : {}),
  };
}

function parseJspmNpmUrl(url: string): ParsedJspmNpmUrl | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }

  const prefix = "/npm:";
  if (!parsedUrl.pathname.startsWith(prefix)) {
    return undefined;
  }

  const npmSpecifier = parsedUrl.pathname.slice(prefix.length);
  const parsedSpecifier = parseBareNpmSpecifier(npmSpecifier);
  if (!parsedSpecifier) {
    return undefined;
  }

  const cdnRoot = `${parsedUrl.protocol}//${parsedUrl.host}`;

  return {
    cdnRoot,
    packageName: parsedSpecifier.packageName,
    ...(parsedSpecifier.version ? { version: parsedSpecifier.version } : {}),
    ...(parsedSpecifier.subpath ? { subpath: parsedSpecifier.subpath } : {}),
  };
}

function resolveWithModuleLoader(
  moduleLoader: RuntimeModuleLoader,
  specifier: string,
  fallbackCdnRoot: string,
): string {
  if (hasResolveSpecifier(moduleLoader)) {
    return moduleLoader.resolveSpecifier(specifier);
  }

  const normalizedSpecifier = specifier.trim();
  return `${fallbackCdnRoot}/npm:${normalizedSpecifier}`;
}

function hasResolveSpecifier(
  loader: RuntimeModuleLoader,
): loader is RuntimeModuleLoader & {
  resolveSpecifier(specifier: string): string;
} {
  return (
    typeof loader === "object" &&
    loader !== null &&
    "resolveSpecifier" in loader &&
    typeof (loader as { resolveSpecifier?: unknown }).resolveSpecifier ===
      "function"
  );
}

function normalizeAutoPinPositiveInteger(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return value;
}

function normalizeAutoPinNonNegativeInteger(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return value;
}

function resolveSubpathEntryFromPackageJson(
  packageJson: JspmPackageJsonShape | undefined,
  subpath: string,
): string | undefined {
  if (!packageJson || !isRecord(packageJson.exports)) {
    return undefined;
  }

  const exportsMap = packageJson.exports as Record<string, unknown>;
  const normalizedSubpath = subpath.replace(/^\/+/, "");
  const key = `./${normalizedSubpath}`;
  const keyedValue = exportsMap[key] ?? exportsMap[`${key}.js`];
  const fromExports = resolvePackageExportPath(keyedValue);
  if (fromExports) {
    return normalizeEntryPath(fromExports);
  }

  return undefined;
}

function resolveRootEntryFromPackageJson(
  packageJson: JspmPackageJsonShape | undefined,
): string | undefined {
  if (!packageJson) {
    return undefined;
  }

  const exportsValue =
    isRecord(packageJson.exports) && "." in packageJson.exports
      ? (packageJson.exports as Record<string, unknown>)["."]
      : packageJson.exports;

  const fromExports = resolvePackageExportPath(exportsValue);
  if (fromExports) {
    return normalizeEntryPath(fromExports);
  }

  const fromModule =
    typeof packageJson.module === "string" ? packageJson.module : undefined;
  if (fromModule) {
    return normalizeEntryPath(fromModule);
  }

  const fromMain =
    typeof packageJson.main === "string" ? packageJson.main : undefined;
  if (fromMain && !fromMain.endsWith(".cjs")) {
    return normalizeEntryPath(fromMain);
  }

  return undefined;
}

function resolvePackageExportPath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolvePackageExportPath(entry);
      if (resolved) {
        return resolved;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const preferredKeys = [
    "import",
    "module",
    "browser",
    "default",
    "production",
    "node",
  ] as const;

  for (const key of preferredKeys) {
    if (!(key in value)) {
      continue;
    }

    const resolved = resolvePackageExportPath(value[key]);
    if (resolved) {
      return resolved;
    }
  }

  for (const nested of Object.values(value)) {
    const resolved = resolvePackageExportPath(nested);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function normalizeEntryPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed.startsWith("./")) {
    return `/${trimmed.slice(2)}`;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function normalizeJspmCdnRoot(input: string | undefined): string {
  const raw = input?.trim() || FALLBACK_JSPM_CDN_ROOT;
  const normalized = raw.replace(/\/$/, "");
  return normalized.endsWith("/npm")
    ? normalized.slice(0, normalized.length - 4)
    : normalized;
}

function createTimeoutAbortScope(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const onAbort = () => {
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
