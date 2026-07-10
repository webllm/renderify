import {
  DEFAULT_JSPM_SPECIFIER_OVERRIDES,
  type RuntimeDiagnostic,
  type RuntimeModuleManifest,
} from "@renderify/ir";
import { FALLBACK_REMOTE_MODULE_MAX_BYTES } from "./runtime-defaults";
import { isNodeRuntime } from "./runtime-environment";
import type {
  RuntimeModuleLoader,
  RuntimeModuleNetworkPolicy,
} from "./runtime-manager.types";
import {
  type RuntimeModuleLoadOptions,
  registerBudgetAwareRuntimeModuleLoader,
  setBudgetedMapEntryWithLimit,
} from "./runtime-module-materialization-budget";
import { RuntimeSourceModuleLoader } from "./runtime-source-module-loader";
import { rewriteImportsAsync } from "./runtime-source-utils";

export interface JspmModuleLoaderOptions {
  cdnBaseUrl?: string;
  importMap?: Record<string, string>;
  remoteFallbackCdnBases?: string[];
  remoteFetchTimeoutMs?: number;
  remoteFetchRetries?: number;
  remoteFetchBackoffMs?: number;
  /** Maximum response-body bytes accepted for one remote module. */
  remoteModuleMaxBytes?: number;
  moduleCacheMaxEntries?: number;
  remoteMaterializedUrlCacheMaxEntries?: number;
}

interface SystemLike {
  import(url: string): Promise<unknown>;
}

const NODE_BUILTIN_MODULE_NAMES = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);
const DEFAULT_REMOTE_FALLBACK_CDN_BASES = ["https://esm.sh"];
const DEFAULT_REMOTE_FETCH_TIMEOUT_MS = 6000;
const DEFAULT_REMOTE_FETCH_RETRIES = 1;
const DEFAULT_REMOTE_FETCH_BACKOFF_MS = 120;
const DEFAULT_MODULE_CACHE_MAX_ENTRIES = 1024;
const DEFAULT_REMOTE_MATERIALIZED_URL_CACHE_MAX_ENTRIES = 1024;

function hasSystemImport(value: unknown): value is SystemLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybeSystem = value as Partial<SystemLike>;
  return typeof maybeSystem.import === "function";
}

export class JspmModuleLoader implements RuntimeModuleLoader {
  private readonly cdnBaseUrl: string;
  private readonly importMap: Record<string, string>;
  private readonly remoteFallbackCdnBases: string[];
  private readonly remoteFetchTimeoutMs: number;
  private readonly remoteFetchRetries: number;
  private readonly remoteFetchBackoffMs: number;
  private readonly remoteModuleMaxBytes: number;
  private readonly moduleCacheMaxEntries: number;
  private readonly remoteMaterializedUrlCacheMaxEntries: number;
  private cache = new Map<string, unknown>();
  private inflight = new Map<string, Promise<unknown>>();
  private verifiedCache = new Map<string, unknown>();
  private verifiedInflight = new Map<string, Promise<unknown>>();
  private readonly remoteMaterializationDiagnostics: RuntimeDiagnostic[] = [];
  private remoteMaterializedUrlCache = new Map<string, string>();
  private remoteMaterializedInflight = new Map<string, Promise<string>>();
  private remoteSourceModuleLoader?: RuntimeSourceModuleLoader;
  private allowArbitraryNetwork = true;
  private isRemoteUrlAllowedFn: (url: string) => boolean = () => true;

  constructor(options: JspmModuleLoaderOptions = {}) {
    this.cdnBaseUrl = this.normalizeCdnBaseUrl(options.cdnBaseUrl);
    this.importMap = options.importMap ?? {};
    this.remoteFallbackCdnBases =
      options.remoteFallbackCdnBases &&
      options.remoteFallbackCdnBases.length > 0
        ? [...options.remoteFallbackCdnBases]
        : [...DEFAULT_REMOTE_FALLBACK_CDN_BASES];
    this.remoteFetchTimeoutMs = normalizePositiveInteger(
      options.remoteFetchTimeoutMs,
      DEFAULT_REMOTE_FETCH_TIMEOUT_MS,
    );
    this.remoteFetchRetries = normalizeNonNegativeInteger(
      options.remoteFetchRetries,
      DEFAULT_REMOTE_FETCH_RETRIES,
    );
    this.remoteFetchBackoffMs = normalizeNonNegativeInteger(
      options.remoteFetchBackoffMs,
      DEFAULT_REMOTE_FETCH_BACKOFF_MS,
    );
    this.remoteModuleMaxBytes = normalizePositiveInteger(
      options.remoteModuleMaxBytes,
      FALLBACK_REMOTE_MODULE_MAX_BYTES,
    );
    this.moduleCacheMaxEntries = normalizePositiveInteger(
      options.moduleCacheMaxEntries,
      DEFAULT_MODULE_CACHE_MAX_ENTRIES,
    );
    this.remoteMaterializedUrlCacheMaxEntries = normalizePositiveInteger(
      options.remoteMaterializedUrlCacheMaxEntries,
      DEFAULT_REMOTE_MATERIALIZED_URL_CACHE_MAX_ENTRIES,
    );
    registerBudgetAwareRuntimeModuleLoader(this, {
      load: (specifier, loadOptions) =>
        this.loadWithOptions(specifier, loadOptions),
      loadVerified: (specifier, integrity, loadOptions) =>
        this.loadVerifiedWithOptions(specifier, integrity, loadOptions),
    });
  }

  async load(specifier: string): Promise<unknown> {
    return this.loadWithOptions(specifier, {});
  }

  private async loadWithOptions(
    specifier: string,
    options: RuntimeModuleLoadOptions,
  ): Promise<unknown> {
    const resolved = this.resolveSpecifier(specifier);
    this.assertRemoteUrlAllowed(resolved);

    const cache = this.cache;
    const inflightEntries = this.inflight;

    if (cache.has(resolved)) {
      return cache.get(resolved);
    }

    const inflight = inflightEntries.get(resolved);
    if (inflight) {
      return inflight;
    }

    const loading = (async () => {
      const loaded = await this.importWithBestEffort(resolved, options);
      setBudgetedMapEntryWithLimit(
        cache,
        resolved,
        loaded,
        this.moduleCacheMaxEntries,
        options.materializationBudget,
      );
      return loaded;
    })();

    inflightEntries.set(resolved, loading);
    try {
      return await loading;
    } finally {
      inflightEntries.delete(resolved);
    }
  }

  async loadVerified(specifier: string, integrity: string): Promise<unknown> {
    return this.loadVerifiedWithOptions(specifier, integrity, {});
  }

  private async loadVerifiedWithOptions(
    specifier: string,
    integrity: string,
    options: RuntimeModuleLoadOptions,
  ): Promise<unknown> {
    const resolved = this.resolveSpecifier(specifier);
    if (!this.isUrl(resolved)) {
      throw new Error(
        `Integrity-pinned loading requires an HTTP(S) module URL: ${resolved}`,
      );
    }
    this.assertRemoteUrlAllowed(resolved);

    const normalizedIntegrity = integrity.trim();
    if (normalizedIntegrity.length === 0) {
      throw new Error(`Module integrity cannot be empty: ${resolved}`);
    }

    const cacheKey = `${resolved}\u0000integrity:${normalizedIntegrity}`;
    const verifiedCache = this.verifiedCache;
    const verifiedInflight = this.verifiedInflight;
    if (verifiedCache.has(cacheKey)) {
      return verifiedCache.get(cacheKey);
    }

    const inflight = verifiedInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const loading = (async () => {
      const manifest: RuntimeModuleManifest = {
        [resolved]: {
          resolvedUrl: resolved,
          integrity: normalizedIntegrity,
        },
      };
      const diagnostics = options.diagnostics ?? [];
      const loader = this.createRemoteSourceModuleLoader(
        manifest,
        diagnostics,
        options,
      );
      const materializedUrl = await loader.resolveRuntimeImportSpecifier(
        resolved,
        undefined,
      );
      const loaded = await import(/* webpackIgnore: true */ materializedUrl);
      setBudgetedMapEntryWithLimit(
        verifiedCache,
        cacheKey,
        loaded,
        this.moduleCacheMaxEntries,
        options.materializationBudget,
      );
      return loaded;
    })();

    verifiedInflight.set(cacheKey, loading);
    try {
      return await loading;
    } finally {
      verifiedInflight.delete(cacheKey);
    }
  }

  configureNetworkPolicy(policy: RuntimeModuleNetworkPolicy): void {
    this.allowArbitraryNetwork = policy.allowArbitraryNetwork;
    this.isRemoteUrlAllowedFn = policy.isRemoteUrlAllowed;

    // Policy-specific materializations must never survive a policy change.
    // Replace the maps instead of clearing them so an older in-flight load
    // cannot repopulate or delete entries in the new policy's caches.
    this.cache = new Map<string, unknown>();
    this.inflight = new Map<string, Promise<unknown>>();
    this.verifiedCache = new Map<string, unknown>();
    this.verifiedInflight = new Map<string, Promise<unknown>>();
    this.remoteMaterializedUrlCache = new Map<string, string>();
    this.remoteMaterializedInflight = new Map<string, Promise<string>>();
    this.remoteSourceModuleLoader = undefined;
  }

  async unload(specifier: string): Promise<void> {
    const resolved = this.resolveSpecifier(specifier);
    this.cache.delete(resolved);
    this.inflight.delete(resolved);
    for (const key of this.verifiedCache.keys()) {
      if (key.startsWith(`${resolved}\u0000integrity:`)) {
        this.verifiedCache.delete(key);
      }
    }
    for (const key of this.verifiedInflight.keys()) {
      if (key.startsWith(`${resolved}\u0000integrity:`)) {
        this.verifiedInflight.delete(key);
      }
    }
  }

  resolveSpecifier(specifier: string): string {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      throw new Error("Empty module specifier is not supported");
    }

    const mapped = this.importMap[normalized];
    if (mapped) {
      return mapped;
    }

    if (this.isUrl(normalized)) {
      return normalized;
    }

    if (this.isNodeBuiltinSpecifier(normalized)) {
      throw new Error(
        `Node.js builtin modules are not supported in JSPM runtime: ${normalized}`,
      );
    }

    if (this.hasUnsupportedScheme(normalized)) {
      const scheme = normalized.slice(0, normalized.indexOf(":"));
      throw new Error(
        `Unsupported module scheme "${scheme}" in specifier: ${normalized}`,
      );
    }

    if (normalized.startsWith("npm:")) {
      return this.resolveNpmSpecifier(normalized.slice(4));
    }

    if (this.isBareNpmSpecifier(normalized)) {
      return this.resolveNpmSpecifier(normalized);
    }

    throw new Error(`Unsupported JSPM specifier: ${normalized}`);
  }

  private async importWithBestEffort(
    resolved: string,
    options: RuntimeModuleLoadOptions,
  ): Promise<unknown> {
    if (
      this.isUrl(resolved) &&
      (!this.allowArbitraryNetwork || options.materializationBudget)
    ) {
      const rewrittenSpecifier = await (options.materializationBudget
        ? this.createRemoteSourceModuleLoader(
            undefined,
            options.diagnostics ?? this.remoteMaterializationDiagnostics,
            options,
          )
        : this.getRemoteSourceModuleLoader()
      ).resolveRuntimeImportSpecifier(resolved, undefined);
      return import(/* webpackIgnore: true */ rewrittenSpecifier);
    }

    const globalValue: unknown = globalThis;
    const maybeSystem =
      typeof globalValue === "object" && globalValue !== null
        ? (globalValue as Record<string, unknown>).System
        : undefined;

    if (hasSystemImport(maybeSystem)) {
      return maybeSystem.import(resolved);
    }

    if (this.shouldMaterializeRemoteModuleInNode(resolved)) {
      const rewrittenSpecifier =
        await this.getRemoteSourceModuleLoader().resolveRuntimeImportSpecifier(
          resolved,
          undefined,
        );
      return import(/* webpackIgnore: true */ rewrittenSpecifier);
    }

    return import(/* webpackIgnore: true */ resolved);
  }

  private isUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private hasUnsupportedScheme(specifier: string): boolean {
    const schemeMatch = /^([a-zA-Z][a-zA-Z\d+\-.]*):/.exec(specifier);
    if (!schemeMatch) {
      return false;
    }

    const scheme = schemeMatch[1].toLowerCase();
    return scheme !== "http" && scheme !== "https" && scheme !== "npm";
  }

  private isBareNpmSpecifier(specifier: string): boolean {
    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/")
    ) {
      return false;
    }

    if (/\s/.test(specifier)) {
      return false;
    }

    return /^[@a-zA-Z0-9][@a-zA-Z0-9._/-]*(?:@[a-zA-Z0-9._-]+)?$/.test(
      specifier,
    );
  }

  private isNodeBuiltinSpecifier(specifier: string): boolean {
    if (specifier.startsWith("node:")) {
      const name = specifier.slice(5).split("/")[0];
      return name.length > 0;
    }

    const target = specifier.startsWith("npm:")
      ? specifier.slice(4)
      : specifier;
    const topLevel = this.extractTopLevelPackageName(target);

    return NODE_BUILTIN_MODULE_NAMES.has(topLevel);
  }

  private extractTopLevelPackageName(specifier: string): string {
    if (specifier.startsWith("@")) {
      const segments = specifier.split("/");
      if (segments.length < 2) {
        return specifier;
      }
      const scopedName = segments[1].split("@")[0];
      return `${segments[0]}/${scopedName}`;
    }

    const firstSegment = specifier.split("/")[0];
    return firstSegment.split("@")[0];
  }

  private resolveNpmSpecifier(specifier: string): string {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      throw new Error("Empty npm specifier is not supported");
    }

    const override = DEFAULT_JSPM_SPECIFIER_OVERRIDES[normalized];
    if (override) {
      return override;
    }

    return `${this.cdnBaseUrl}/npm:${normalized}`;
  }

  private normalizeCdnBaseUrl(input?: string): string {
    const raw = input?.trim() || "https://ga.jspm.io";
    const normalized = raw.replace(/\/$/, "");
    return normalized.endsWith("/npm")
      ? normalized.slice(0, normalized.length - 4)
      : normalized;
  }

  private shouldMaterializeRemoteModuleInNode(specifier: string): boolean {
    return isNodeRuntime() && this.isUrl(specifier);
  }

  private getRemoteSourceModuleLoader(): RuntimeSourceModuleLoader {
    if (this.remoteSourceModuleLoader) {
      return this.remoteSourceModuleLoader;
    }

    this.remoteSourceModuleLoader = this.createRemoteSourceModuleLoader(
      undefined,
      this.remoteMaterializationDiagnostics,
    );

    return this.remoteSourceModuleLoader;
  }

  private createRemoteSourceModuleLoader(
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    options: RuntimeModuleLoadOptions = {},
  ): RuntimeSourceModuleLoader {
    return new RuntimeSourceModuleLoader({
      moduleManifest,
      diagnostics,
      materializedModuleUrlCache: this.remoteMaterializedUrlCache,
      materializedModuleInflight: this.remoteMaterializedInflight,
      remoteFallbackCdnBases: this.remoteFallbackCdnBases,
      remoteFetchTimeoutMs: this.remoteFetchTimeoutMs,
      remoteFetchRetries: this.remoteFetchRetries,
      remoteFetchBackoffMs: this.remoteFetchBackoffMs,
      remoteModuleMaxBytes: this.remoteModuleMaxBytes,
      materializedModuleUrlCacheMaxEntries:
        this.remoteMaterializedUrlCacheMaxEntries,
      materializationBudget: options.materializationBudget,
      canMaterializeRuntimeModules: () => this.canMaterializeRemoteModules(),
      rewriteImportsAsync: (code, resolver) =>
        rewriteImportsAsync(code, resolver),
      createInlineModuleUrl: (code) => this.createInlineModuleUrl(code),
      resolveRuntimeSourceSpecifier: (specifier) => {
        try {
          return this.resolveSpecifier(specifier);
        } catch {
          return specifier;
        }
      },
      isRemoteUrlAllowed: (url) => this.isRemoteUrlAllowedFn(url),
    });
  }

  private assertRemoteUrlAllowed(url: string): void {
    if (!this.isUrl(url) || this.isRemoteUrlAllowedFn(url)) {
      return;
    }

    throw new Error(
      `Remote module URL is blocked by runtime network policy: ${url}`,
    );
  }

  private createInlineModuleUrl(code: string): string {
    if (typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      return `data:text/javascript;base64,${encoded}`;
    }

    if (typeof TextEncoder !== "undefined" && typeof btoa === "function") {
      const bytes = new TextEncoder().encode(code);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return `data:text/javascript;base64,${btoa(binary)}`;
    }

    throw new Error("Remote module materialization is unavailable");
  }

  private canMaterializeRemoteModules(): boolean {
    return (
      typeof Buffer !== "undefined" ||
      (typeof TextEncoder !== "undefined" && typeof btoa === "function")
    );
  }
}

function normalizePositiveInteger(
  value: number | undefined,
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

function normalizeNonNegativeInteger(
  value: number | undefined,
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
