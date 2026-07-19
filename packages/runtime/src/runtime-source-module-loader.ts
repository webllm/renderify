import type { RuntimeDiagnostic, RuntimeModuleManifest } from "@renderify/ir";
import {
  buildRemoteModuleAttemptUrls,
  createCssProxyModuleSource,
  createJsonProxyModuleSource,
  createTextProxyModuleSource,
  createUrlProxyModuleSource,
  delay,
  fetchWithTimeout,
  isBinaryLikeContentType,
  isCssModuleResponse,
  isJavaScriptModuleResponse,
  isJsonModuleResponse,
  isLikelyUnpinnedJspmNpmUrl,
  type RemoteModuleFetchResult,
} from "./module-fetch";
import {
  RuntimeModuleIntegrityError,
  verifyModuleIntegrity,
} from "./module-integrity";
import { createNodeModuleFileUrl } from "./node-module-file-store";
import { isBrowserRuntime, isNodeRuntime } from "./runtime-environment";
import {
  assertRuntimeModuleMaterializationBudgetActive,
  claimRuntimeModuleMaterialization,
  isRuntimeModuleMaterializationLimitError,
  type RuntimeModuleMaterializationBudget,
  setBudgetedMapEntryWithLimit,
} from "./runtime-module-materialization-budget";
import { isHttpUrl } from "./runtime-specifier";

export interface RuntimeSourceModuleLoaderOptions {
  moduleManifest: RuntimeModuleManifest | undefined;
  diagnostics: RuntimeDiagnostic[];
  materializedModuleUrlCache: Map<string, string>;
  materializedModuleInflight: Map<string, Promise<string>>;
  remoteFallbackCdnBases: string[];
  remoteFetchTimeoutMs: number;
  remoteFetchRetries: number;
  remoteFetchBackoffMs: number;
  remoteModuleMaxBytes: number;
  canMaterializeRuntimeModules: () => boolean;
  rewriteImportsAsync: (
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ) => Promise<string>;
  createInlineModuleUrl: (code: string) => string | Promise<string>;
  resolveRuntimeSourceSpecifier: (
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest?: boolean,
  ) => string;
  isRemoteUrlAllowed?: (url: string) => boolean;
  signal?: AbortSignal;
  materializedModuleUrlCacheMaxEntries?: number;
  localNodeSpecifierUrlCacheMaxEntries?: number;
  materializationBudget?: RuntimeModuleMaterializationBudget;
}

type NodeModuleResolver = {
  resolve(specifier: string): string;
};

type NodePathToFileUrl = (path: string) => URL;
type NodePathModule = {
  dirname(path: string): string;
  join(...segments: string[]): string;
};
type NodeFsModule = {
  existsSync(path: string): boolean;
};

const PREACT_LOCAL_ESM_ENTRYPOINTS = new Map<string, string>([
  ["preact", "dist/preact.mjs"],
  ["preact/hooks", "hooks/dist/hooks.mjs"],
  ["preact/jsx-runtime", "jsx-runtime/dist/jsxRuntime.mjs"],
  ["preact/compat", "compat/dist/compat.mjs"],
]);
const PREACT_COMPANION_CANONICAL_SPECIFIERS = new Map<string, string>([
  ["preact", "preact"],
  ["preact/hooks", "preact/hooks"],
  ["preact/jsx-runtime", "preact/jsx-runtime"],
  ["preact/jsx-dev-runtime", "preact/jsx-runtime"],
  ["preact/compat", "preact/compat"],
  ["react", "preact/compat"],
  ["react-dom", "preact/compat"],
  ["react-dom/client", "preact/compat"],
  ["react/jsx-runtime", "preact/jsx-runtime"],
  ["react/jsx-dev-runtime", "preact/jsx-runtime"],
]);
const PREACT_BROWSER_FILE_ENTRYPOINTS = new Map<string, string>([
  ["preact", "dist/preact.module.js"],
  ["preact/hooks", "hooks/dist/hooks.module.js"],
  ["preact/jsx-runtime", "jsx-runtime/dist/jsxRuntime.module.js"],
  ["preact/compat", "compat/dist/compat.module.js"],
]);
const PREACT_ESM_SH_SUBPATHS = new Map<string, string>([
  ["preact", ""],
  ["preact/hooks", "/hooks"],
  ["preact/jsx-runtime", "/jsx-runtime"],
  ["preact/compat", "/compat"],
]);
const PREACT_BROWSER_FILE_PACKAGE_BASE_PATTERNS = [
  /^(.*\/node_modules\/(?:\.pnpm\/preact@[^/]+\/node_modules\/)?preact)(?:\/|$)/i,
  /^(\/npm:preact@[^/]+)(?:\/|$)/i,
  /^(\/npm\/preact@[^/]+)(?:\/|$)/i,
  /^(\/preact@[^/]+)(?:\/|$)/i,
];
const DEFAULT_MATERIALIZED_MODULE_URL_CACHE_MAX_ENTRIES = 1024;
const DEFAULT_LOCAL_NODE_SPECIFIER_CACHE_MAX_ENTRIES = 512;

type MaterializationDependencyGraph = Map<string, Map<string, number>>;

const MATERIALIZATION_DEPENDENCY_GRAPHS = new WeakMap<
  Map<string, Promise<string>>,
  MaterializationDependencyGraph
>();

export class RuntimeSourceModuleLoader {
  private readonly moduleManifest: RuntimeModuleManifest | undefined;
  private readonly diagnostics: RuntimeDiagnostic[];
  private readonly materializedModuleUrlCache: Map<string, string>;
  private readonly materializedModuleInflight: Map<string, Promise<string>>;
  private readonly materializationDependencyGraph: MaterializationDependencyGraph;
  private readonly remoteFallbackCdnBases: string[];
  private readonly remoteFetchTimeoutMs: number;
  private readonly remoteFetchRetries: number;
  private readonly remoteFetchBackoffMs: number;
  private readonly remoteModuleMaxBytes: number;
  private readonly canMaterializeRuntimeModulesFn: () => boolean;
  private readonly rewriteImportsAsyncFn: (
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ) => Promise<string>;
  private readonly createInlineModuleUrlFn: (
    code: string,
  ) => string | Promise<string>;
  private readonly resolveRuntimeSourceSpecifierFn: (
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest?: boolean,
  ) => string;
  private readonly isRemoteUrlAllowedFn: (url: string) => boolean;
  private readonly signal: AbortSignal | undefined;
  private readonly materializedModuleUrlCacheMaxEntries: number;
  private readonly localNodeSpecifierUrlCacheMaxEntries: number;
  private readonly materializationBudget:
    | RuntimeModuleMaterializationBudget
    | undefined;
  private readonly integrityByResolvedUrl: Map<string, string>;
  private readonly preactVersion: string | undefined;
  private readonly localNodeSpecifierUrlCache = new Map<
    string,
    string | null
  >();
  private readonly auditedPreservedRemoteImports = new Set<string>();
  private readonly preservedRemoteImportAuditInflight = new Map<
    string,
    Promise<void>
  >();
  private nodeModuleResolverPromise?: Promise<NodeModuleResolver | undefined>;
  private nodePathToFileUrlPromise?: Promise<NodePathToFileUrl | undefined>;
  private nodePathModulePromise?: Promise<NodePathModule | undefined>;
  private nodeFsModulePromise?: Promise<NodeFsModule | undefined>;
  private preactPackageRootPromise?: Promise<string | undefined>;

  constructor(options: RuntimeSourceModuleLoaderOptions) {
    this.moduleManifest = options.moduleManifest;
    this.diagnostics = options.diagnostics;
    this.materializedModuleUrlCache = options.materializedModuleUrlCache;
    this.materializedModuleInflight = options.materializedModuleInflight;
    this.materializationDependencyGraph = getMaterializationDependencyGraph(
      options.materializedModuleInflight,
    );
    this.remoteFallbackCdnBases = options.remoteFallbackCdnBases;
    this.remoteFetchTimeoutMs = options.remoteFetchTimeoutMs;
    this.remoteFetchRetries = options.remoteFetchRetries;
    this.remoteFetchBackoffMs = options.remoteFetchBackoffMs;
    this.remoteModuleMaxBytes = options.remoteModuleMaxBytes;
    this.canMaterializeRuntimeModulesFn = options.canMaterializeRuntimeModules;
    this.rewriteImportsAsyncFn = options.rewriteImportsAsync;
    this.createInlineModuleUrlFn = options.createInlineModuleUrl;
    this.resolveRuntimeSourceSpecifierFn =
      options.resolveRuntimeSourceSpecifier;
    this.isRemoteUrlAllowedFn = options.isRemoteUrlAllowed ?? (() => true);
    this.signal = options.signal;
    this.materializedModuleUrlCacheMaxEntries = normalizeCacheMaxEntries(
      options.materializedModuleUrlCacheMaxEntries,
      DEFAULT_MATERIALIZED_MODULE_URL_CACHE_MAX_ENTRIES,
    );
    this.localNodeSpecifierUrlCacheMaxEntries = normalizeCacheMaxEntries(
      options.localNodeSpecifierUrlCacheMaxEntries,
      DEFAULT_LOCAL_NODE_SPECIFIER_CACHE_MAX_ENTRIES,
    );
    this.materializationBudget = options.materializationBudget;
    this.integrityByResolvedUrl = collectIntegrityByResolvedUrl(
      this.moduleManifest,
    );
    this.preactVersion = resolveManifestPreactVersion(this.moduleManifest);
  }

  async importSourceModuleFromCode(code: string): Promise<unknown> {
    this.throwIfAborted();
    if (this.canMaterializeRuntimeModulesFn()) {
      const rewrittenEntry = await this.rewriteImportsAsyncFn(
        code,
        async (specifier) =>
          this.resolveRuntimeImportSpecifier(specifier, undefined),
      );
      this.throwIfAborted();
      const entryUrl = await this.createMaterializedModuleUrl(rewrittenEntry);
      return import(/* webpackIgnore: true */ entryUrl);
    }

    if (typeof Buffer !== "undefined") {
      const encoded = Buffer.from(code, "utf8").toString("base64");
      const dataUrl = `data:text/javascript;base64,${encoded}`;
      return import(/* webpackIgnore: true */ dataUrl);
    }

    throw new Error("No runtime module import strategy is available");
  }

  async resolveRuntimeImportSpecifier(
    specifier: string,
    parentUrl: string | undefined,
    parentMaterializationKey?: string,
  ): Promise<string> {
    this.throwIfAborted();
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return trimmed;
    }

    const explicitManifestResolved =
      this.resolveExplicitManifestSpecifier(trimmed);

    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
      return trimmed;
    }

    if (!explicitManifestResolved) {
      const localPreact = await this.resolveLocalPreactSpecifier(trimmed);
      if (localPreact) {
        return localPreact;
      }
    }

    if (isHttpUrl(trimmed)) {
      return this.materializeRemoteModule(trimmed, parentMaterializationKey);
    }

    if (
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.startsWith("/")
    ) {
      if (!parentUrl || !isHttpUrl(parentUrl)) {
        this.diagnostics.push({
          level: "warning",
          code: "RUNTIME_SOURCE_IMPORT_UNRESOLVED",
          message: `Cannot resolve relative source import without parent URL: ${trimmed}`,
        });
        return trimmed;
      }

      const absolute = new URL(trimmed, parentUrl).toString();
      const localFromAbsolute =
        await this.resolveLocalPreactSpecifier(absolute);
      if (localFromAbsolute) {
        return localFromAbsolute;
      }
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeRemoteModule(absolute, parentMaterializationKey);
    }

    const resolved = this.resolveRuntimeSourceSpecifierFn(
      trimmed,
      this.moduleManifest,
      this.diagnostics,
      false,
    );
    if (!explicitManifestResolved) {
      const localFromResolved =
        await this.resolveLocalPreactSpecifier(resolved);
      if (localFromResolved) {
        return localFromResolved;
      }
    }

    if (isHttpUrl(resolved)) {
      return this.materializeRemoteModule(resolved, parentMaterializationKey);
    }

    if (
      (resolved.startsWith("./") ||
        resolved.startsWith("../") ||
        resolved.startsWith("/")) &&
      parentUrl &&
      isHttpUrl(parentUrl)
    ) {
      const absolute = new URL(resolved, parentUrl).toString();
      const localFromAbsolute =
        await this.resolveLocalPreactSpecifier(absolute);
      if (localFromAbsolute) {
        return localFromAbsolute;
      }
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeRemoteModule(absolute, parentMaterializationKey);
    }

    return resolved;
  }

  async materializeRemoteModule(
    url: string,
    parentMaterializationKey?: string,
  ): Promise<string> {
    this.throwIfAborted();
    const normalizedUrl = url.trim();
    if (normalizedUrl.length === 0) {
      return normalizedUrl;
    }

    const expectedIntegrity = this.resolveExpectedIntegrity(normalizedUrl);
    const cacheKey = this.createMaterializedCacheKey(
      normalizedUrl,
      expectedIntegrity,
    );
    try {
      if (this.materializationBudget) {
        claimRuntimeModuleMaterialization(
          this.materializationBudget,
          cacheKey,
          normalizedUrl,
        );
      }
    } catch (error) {
      if (isRuntimeModuleMaterializationLimitError(error)) {
        this.pushMaterializationLimitDiagnostic(error.message);
      }
      throw error;
    }

    if (
      !expectedIntegrity &&
      isBrowserRuntime() &&
      this.shouldPreserveRemoteImport(normalizedUrl)
    ) {
      if (!this.isRemoteImportAllowed(normalizedUrl)) {
        throw new Error(
          `Remote module URL is blocked by runtime network policy: ${normalizedUrl}`,
        );
      }
      const releaseDependency = parentMaterializationKey
        ? this.registerMaterializationDependency(
            parentMaterializationKey,
            cacheKey,
          )
        : undefined;
      try {
        await this.auditPreservedRemoteImport(normalizedUrl, cacheKey);
        return normalizedUrl;
      } finally {
        releaseDependency?.();
      }
    }

    const cachedUrl = this.materializedModuleUrlCache.get(cacheKey);
    if (cachedUrl) {
      return cachedUrl;
    }

    const releaseDependency = parentMaterializationKey
      ? this.registerMaterializationDependency(
          parentMaterializationKey,
          cacheKey,
        )
      : undefined;

    try {
      const inflight = this.materializedModuleInflight.get(cacheKey);
      if (inflight) {
        return await inflight;
      }

      const loading = (async () => {
        const fetched =
          await this.fetchRemoteModuleCodeWithFallback(normalizedUrl);
        const rewritten = await this.materializeFetchedModuleSource(
          fetched,
          cacheKey,
        );

        assertRuntimeModuleMaterializationBudgetActive(
          this.materializationBudget,
        );

        const inlineUrl = await this.createMaterializedModuleUrl(rewritten);
        setBudgetedMapEntryWithLimit(
          this.materializedModuleUrlCache,
          cacheKey,
          inlineUrl,
          this.materializedModuleUrlCacheMaxEntries,
          this.materializationBudget,
        );
        const fetchedIntegrity =
          this.resolveExpectedIntegrity(
            fetched.originalUrl,
            normalizedUrl,
            fetched.requestUrl,
            fetched.url,
          ) ?? expectedIntegrity;
        setBudgetedMapEntryWithLimit(
          this.materializedModuleUrlCache,
          this.createMaterializedCacheKey(fetched.url, fetchedIntegrity),
          inlineUrl,
          this.materializedModuleUrlCacheMaxEntries,
          this.materializationBudget,
        );
        return inlineUrl;
      })();

      this.materializedModuleInflight.set(cacheKey, loading);
      try {
        return await loading;
      } finally {
        if (this.materializedModuleInflight.get(cacheKey) === loading) {
          this.materializedModuleInflight.delete(cacheKey);
        }
      }
    } finally {
      releaseDependency?.();
    }
  }

  async materializeFetchedModuleSource(
    fetched: RemoteModuleFetchResult,
    parentMaterializationKey?: string,
  ): Promise<string> {
    await this.verifyFetchedModuleIntegrity(fetched);

    if (isCssModuleResponse(fetched)) {
      return createCssProxyModuleSource(fetched.code, fetched.url);
    }

    if (isJsonModuleResponse(fetched)) {
      return this.createJsonProxyModuleSource(fetched);
    }

    if (!isJavaScriptModuleResponse(fetched)) {
      this.diagnostics.push({
        level: "warning",
        code: "RUNTIME_SOURCE_ASSET_PROXY",
        message: `Treating non-JS module as proxied asset: ${fetched.url} (${fetched.contentType || "unknown"})`,
      });

      if (isBinaryLikeContentType(fetched.contentType)) {
        return createUrlProxyModuleSource(fetched.url);
      }

      return createTextProxyModuleSource(fetched.code);
    }

    const code = this.stripSourceMapDirectives(fetched.code);

    return this.rewriteImportsAsyncFn(code, async (childSpecifier) =>
      this.resolveRuntimeImportSpecifier(
        childSpecifier,
        fetched.url,
        parentMaterializationKey,
      ),
    );
  }

  private async createMaterializedModuleUrl(code: string): Promise<string> {
    if (!isBrowserRuntime()) {
      const nodeFileUrl = await createNodeModuleFileUrl(code);
      if (nodeFileUrl) {
        return nodeFileUrl;
      }
    }

    return await this.createInlineModuleUrlFn(code);
  }

  async fetchRemoteModuleCodeWithFallback(
    url: string,
    signal: AbortSignal | undefined = this.signal,
  ): Promise<RemoteModuleFetchResult> {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const attempts = buildRemoteModuleAttemptUrls(
      url,
      this.remoteFallbackCdnBases,
      {
        runtime: isNodeRuntime() ? "node" : "browser",
        preactVersion: this.preactVersion,
      },
    );

    if (attempts.length === 0) {
      throw new Error(`Failed to load module: ${url}`);
    }

    const filteredAttempts = this.filterDisallowedAttempts(attempts);
    if (filteredAttempts.length === 0) {
      throw new Error(
        `Remote module URL is blocked by runtime network policy: ${url}`,
      );
    }

    const preferredBundleIndex = this.resolvePreferredMaterialUiBundleIndex(
      url,
      filteredAttempts,
    );
    let orderedAttempts = filteredAttempts;
    if (preferredBundleIndex >= 0) {
      const preferredBundle = filteredAttempts[preferredBundleIndex];
      try {
        return await this.fetchRemoteModuleAttemptWithRetries(
          preferredBundle,
          url,
          0,
          signal,
        );
      } catch (error) {
        if (this.isAbortError(error, signal)) {
          throw error;
        }
        orderedAttempts = filteredAttempts.filter(
          (_attempt, index) => index !== preferredBundleIndex,
        );
        if (orderedAttempts.length === 0) {
          throw error;
        }
      }
    }

    const hedgeDelayMs = Math.max(
      50,
      Math.min(300, this.remoteFetchBackoffMs || 100),
    );
    const attemptControllers = orderedAttempts.map(() =>
      this.createAbortController(),
    );
    const abortAttempts = () => {
      for (const controller of attemptControllers) {
        controller?.abort();
      }
    };
    signal?.addEventListener("abort", abortAttempts, { once: true });
    if (signal?.aborted) {
      abortAttempts();
    }
    const fetchTasks = orderedAttempts.map((attempt, index) =>
      this.fetchRemoteModuleAttemptWithRetries(
        attempt,
        url,
        index === 0 ? 0 : hedgeDelayMs * index,
        attemptControllers[index]?.signal ?? signal,
      ),
    );

    try {
      return await Promise.any(fetchTasks);
    } catch (error) {
      if (error instanceof AggregateError && error.errors.length > 0) {
        throw error.errors[error.errors.length - 1];
      }

      throw error;
    } finally {
      signal?.removeEventListener("abort", abortAttempts);
      abortAttempts();
    }
  }

  async probeRemoteModule(
    url: string,
    signal: AbortSignal | undefined = this.signal,
  ): Promise<RemoteModuleFetchResult> {
    const fetched = await this.fetchRemoteModuleCodeWithFallback(url, signal);
    await this.verifyFetchedModuleIntegrity(fetched);
    return fetched;
  }

  private resolvePreferredMaterialUiBundleIndex(
    originalUrl: string,
    attempts: string[],
  ): number {
    if (this.resolveExpectedIntegrity(originalUrl)) {
      return -1;
    }

    return attempts.findIndex((attempt) => {
      let parsed: URL;
      try {
        parsed = new URL(attempt);
      } catch {
        return false;
      }

      return (
        parsed.hostname.toLowerCase() === "esm.sh" &&
        /^\/@mui\/(?:material|icons-material)(?:@[^/]+)?(?:\/|$)/.test(
          parsed.pathname,
        ) &&
        parsed.searchParams.has("bundle")
      );
    });
  }

  private async fetchRemoteModuleAttemptWithRetries(
    attempt: string,
    originalUrl: string,
    startDelayMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteModuleFetchResult> {
    if (startDelayMs > 0) {
      await this.delayWithSignal(startDelayMs, signal);
    }

    let lastError: unknown;
    for (let retry = 0; retry <= this.remoteFetchRetries; retry += 1) {
      try {
        const fetched = await fetchWithTimeout(
          attempt,
          this.remoteFetchTimeoutMs,
          {
            signal,
            consume: async (response, timeoutSignal) => {
              if (!response.ok) {
                throw new Error(
                  `Failed to load module ${attempt}: HTTP ${response.status}`,
                );
              }

              const effectiveUrl = response.url || attempt;
              this.assertEffectiveRemoteUrlAllowed(
                originalUrl,
                attempt,
                effectiveUrl,
              );
              if (
                isLikelyUnpinnedJspmNpmUrl(attempt) ||
                isLikelyUnpinnedJspmNpmUrl(effectiveUrl)
              ) {
                throw new Error(
                  `Failed to load module ${attempt}: non-executable JSPM package index endpoint`,
                );
              }

              return {
                url: effectiveUrl,
                code: await this.readRemoteModuleText(
                  response,
                  effectiveUrl,
                  timeoutSignal,
                ),
                contentType:
                  response.headers.get("content-type")?.toLowerCase() ?? "",
                requestUrl: attempt,
                originalUrl,
              };
            },
          },
        );

        if (attempt !== originalUrl) {
          this.pushDiagnosticOnce({
            level: "warning",
            code: "RUNTIME_SOURCE_IMPORT_FALLBACK_USED",
            message: `Loaded module via fallback URL: ${originalUrl} -> ${attempt}`,
          });
        }

        if (retry > 0) {
          this.pushDiagnosticOnce({
            level: "warning",
            code: "RUNTIME_SOURCE_IMPORT_RETRY_SUCCEEDED",
            message: `Recovered remote module after retry ${retry}: ${attempt}`,
          });
        }

        return fetched;
      } catch (error) {
        if (this.isAbortError(error, signal)) {
          throw error;
        }
        lastError = error;
        if (retry >= this.remoteFetchRetries) {
          break;
        }
        await this.delayWithSignal(
          this.remoteFetchBackoffMs * Math.max(1, retry + 1),
          signal,
        );
      }
    }

    throw lastError ?? new Error(`Failed to load module: ${attempt}`);
  }

  private async readRemoteModuleText(
    response: Response,
    effectiveUrl: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const declaredLength = response.headers.get("content-length")?.trim();
    if (
      declaredLength &&
      /^\d+$/.test(declaredLength) &&
      BigInt(declaredLength) > BigInt(this.remoteModuleMaxBytes)
    ) {
      this.cancelResponseBody(response);
      throw this.createRemoteModuleSizeError(
        effectiveUrl,
        `Content-Length: ${declaredLength}`,
      );
    }

    const body = response.body;
    if (!body) {
      return "";
    }

    const reader = body.getReader();
    let bytes = new Uint8Array(Math.min(this.remoteModuleMaxBytes, 64 * 1024));
    let receivedBytes = 0;
    let complete = false;
    const handleAbort = () => {
      void reader.cancel(createAbortError()).catch(() => {});
    };
    signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      while (true) {
        const chunk = await reader.read();
        if (signal?.aborted) {
          throw createAbortError();
        }
        if (chunk.done) {
          complete = true;
          break;
        }

        if (
          chunk.value.byteLength >
          this.remoteModuleMaxBytes - receivedBytes
        ) {
          throw this.createRemoteModuleSizeError(effectiveUrl);
        }
        const nextReceivedBytes = receivedBytes + chunk.value.byteLength;
        if (nextReceivedBytes > bytes.byteLength) {
          const nextCapacity = Math.min(
            this.remoteModuleMaxBytes,
            Math.max(nextReceivedBytes, Math.max(1, bytes.byteLength * 2)),
          );
          const grown = new Uint8Array(nextCapacity);
          grown.set(bytes.subarray(0, receivedBytes));
          bytes = grown;
        }
        bytes.set(chunk.value, receivedBytes);
        receivedBytes = nextReceivedBytes;
      }
      return new TextDecoder().decode(bytes.subarray(0, receivedBytes));
    } catch (error) {
      if (!complete) {
        void reader.cancel().catch(() => {});
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", handleAbort);
      reader.releaseLock();
    }
  }

  private cancelResponseBody(response: Response): void {
    if (!response.body || response.body.locked) {
      return;
    }
    void response.body.cancel().catch(() => {});
  }

  private createRemoteModuleSizeError(url: string, detail?: string): Error {
    return new Error(
      `Remote module ${url} exceeds maximum response size of ${this.remoteModuleMaxBytes} bytes${detail ? ` (${detail})` : ""}`,
    );
  }

  private createJsonProxyModuleSource(
    fetched: RemoteModuleFetchResult,
  ): string {
    try {
      const parsed = JSON.parse(fetched.code) as unknown;
      return createJsonProxyModuleSource(parsed);
    } catch (error) {
      this.diagnostics.push({
        level: "warning",
        code: "RUNTIME_SOURCE_JSON_PARSE_FAILED",
        message: `${fetched.requestUrl}: ${this.errorToMessage(error)}`,
      });
      return createTextProxyModuleSource(fetched.code);
    }
  }

  private filterDisallowedAttempts(attempts: string[]): string[] {
    const allowed: string[] = [];
    for (const attempt of attempts) {
      if (this.isRemoteImportAllowed(attempt)) {
        allowed.push(attempt);
      }
    }

    return allowed;
  }

  private isRemoteImportAllowed(url: string): boolean {
    if (this.isRemoteUrlAllowedFn(url)) {
      return true;
    }

    this.diagnostics.push({
      level: "warning",
      code: "RUNTIME_SOURCE_IMPORT_BLOCKED",
      message: `Blocked remote module URL by runtime network policy: ${url}`,
    });
    return false;
  }

  private assertEffectiveRemoteUrlAllowed(
    originalUrl: string,
    requestUrl: string,
    effectiveUrl: string,
  ): void {
    if (this.isRemoteUrlAllowedFn(effectiveUrl)) {
      return;
    }

    this.diagnostics.push({
      level: "warning",
      code: "RUNTIME_SOURCE_IMPORT_REDIRECT_BLOCKED",
      message: `Blocked remote module response URL by runtime network policy: ${originalUrl} (request: ${requestUrl}, effective: ${effectiveUrl})`,
    });
    throw new Error(
      `Remote module response URL is blocked by runtime network policy: ${effectiveUrl}`,
    );
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private pushMaterializationLimitDiagnostic(message: string): void {
    if (
      this.diagnostics.some(
        (item) => item.code === "RUNTIME_MODULE_MATERIALIZATION_LIMIT_EXCEEDED",
      )
    ) {
      return;
    }

    this.diagnostics.push({
      level: "error",
      code: "RUNTIME_MODULE_MATERIALIZATION_LIMIT_EXCEEDED",
      message,
    });
  }

  private pushDiagnosticOnce(diagnostic: RuntimeDiagnostic): void {
    if (
      this.diagnostics.some(
        (item) =>
          item.code === diagnostic.code && item.message === diagnostic.message,
      )
    ) {
      return;
    }

    this.diagnostics.push(diagnostic);
  }

  private createAbortController(): AbortController | undefined {
    if (typeof AbortController === "undefined") {
      return undefined;
    }

    return new AbortController();
  }

  private isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      return true;
    }

    return error instanceof Error && error.name === "AbortError";
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw createAbortError();
    }
  }

  private async delayWithSignal(
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (ms <= 0) {
      return;
    }

    if (!signal) {
      await delay(ms);
      return;
    }

    if (signal.aborted) {
      throw createAbortError();
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private shouldPreserveRemoteImport(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return false;
    }

    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (host === "ga.jspm.io" || host === "cdn.jspm.io") {
      return /^\/npm:(?:preact(?:-render-to-string)?|react(?:-dom)?)@[^/]+(?:\/|$)/.test(
        path,
      );
    }
    if (host === "esm.sh") {
      return /^\/(?:v\d+\/)?(?:preact(?:-render-to-string)?|react(?:-dom)?)@[^/]+(?:\/|$)/.test(
        path,
      );
    }
    if (host === "cdn.jsdelivr.net") {
      return /^\/npm\/(?:preact(?:-render-to-string)?|react(?:-dom)?)@[^/]+(?:\/|$)/.test(
        path,
      );
    }
    if (host === "unpkg.com") {
      return /^\/(?:preact(?:-render-to-string)?|react(?:-dom)?)@[^/]+(?:\/|$)/.test(
        path,
      );
    }

    const browserOrigin = this.resolveBrowserOrigin();
    if (!browserOrigin || parsed.origin !== browserOrigin) {
      return false;
    }

    return /^\/node_modules\/(?:\.pnpm\/(?:preact(?:-render-to-string)?|react(?:-dom)?)@[^/]+\/node_modules\/)?(?:preact(?:-render-to-string)?|react(?:-dom)?)(?:\/|$)/.test(
      path,
    );
  }

  private resolveBrowserOrigin(): string | undefined {
    if (typeof window === "undefined") {
      return undefined;
    }
    const origin = window.location?.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
  }

  private async auditPreservedRemoteImport(
    url: string,
    cacheKey: string,
  ): Promise<void> {
    if (this.auditedPreservedRemoteImports.has(cacheKey)) {
      return;
    }

    const existing = this.preservedRemoteImportAuditInflight.get(cacheKey);
    if (existing) {
      await existing;
      return;
    }

    const audit = (async () => {
      const fetched = await this.fetchRemoteModuleAttemptWithRetries(
        url,
        url,
        0,
        this.signal,
      );
      if (!this.shouldPreserveRemoteImport(fetched.url)) {
        throw new Error(
          `Preserved Preact module redirected outside trusted package paths: ${url} -> ${fetched.url}`,
        );
      }
      await this.verifyFetchedModuleIntegrity(fetched);
      if (!isJavaScriptModuleResponse(fetched)) {
        throw new Error(
          `Preserved Preact module is not JavaScript: ${fetched.url}`,
        );
      }

      const code = this.stripSourceMapDirectives(fetched.code);
      await this.rewriteImportsAsyncFn(code, async (childSpecifier) => {
        const preservedCompanion = this.resolvePreservedPreactCompanionUrl(
          childSpecifier,
          fetched.url,
        );
        await this.resolveRuntimeImportSpecifier(
          preservedCompanion ?? childSpecifier,
          fetched.url,
          cacheKey,
        );
        return childSpecifier;
      });
      this.auditedPreservedRemoteImports.add(cacheKey);
    })();

    this.preservedRemoteImportAuditInflight.set(cacheKey, audit);
    try {
      await audit;
    } finally {
      if (this.preservedRemoteImportAuditInflight.get(cacheKey) === audit) {
        this.preservedRemoteImportAuditInflight.delete(cacheKey);
      }
    }
  }

  private resolvePreservedPreactCompanionUrl(
    specifier: string,
    parentUrl: string,
  ): string | undefined {
    const canonical = PREACT_COMPANION_CANONICAL_SPECIFIERS.get(
      specifier.trim(),
    );
    if (!canonical) {
      return undefined;
    }

    let parsed: URL;
    try {
      parsed = new URL(parentUrl);
    } catch {
      return undefined;
    }

    const fileEntry = PREACT_BROWSER_FILE_ENTRYPOINTS.get(canonical);
    if (!fileEntry) {
      return undefined;
    }

    const path = parsed.pathname;
    const filePackageBase = this.resolvePreservedPreactFilePackageBase(path);
    if (filePackageBase) {
      return new URL(
        `${filePackageBase}/${fileEntry}`,
        parsed.origin,
      ).toString();
    }

    if (parsed.hostname.toLowerCase() === "esm.sh") {
      const esmPackageBase = path.match(
        /^(\/(?:v\d+\/)?preact@[^/]+)(?:\/|$)/i,
      )?.[1];
      if (!esmPackageBase) {
        return undefined;
      }
      const esmSubpath = PREACT_ESM_SH_SUBPATHS.get(canonical);
      return esmSubpath === undefined
        ? undefined
        : new URL(`${esmPackageBase}${esmSubpath}`, parsed.origin).toString();
    }

    return undefined;
  }

  private resolvePreservedPreactFilePackageBase(
    path: string,
  ): string | undefined {
    for (const pattern of PREACT_BROWSER_FILE_PACKAGE_BASE_PATTERNS) {
      const base = path.match(pattern)?.[1];
      if (base) {
        return base;
      }
    }
    return undefined;
  }

  private resolveExplicitManifestSpecifier(
    specifier: string,
  ): string | undefined {
    const descriptor = this.moduleManifest?.[specifier];
    if (!descriptor || typeof descriptor.resolvedUrl !== "string") {
      return undefined;
    }

    const resolved = descriptor.resolvedUrl.trim();
    return resolved.length > 0 ? resolved : undefined;
  }

  private async resolveLocalPreactSpecifier(
    specifier: string,
  ): Promise<string | undefined> {
    if (isBrowserRuntime()) {
      return undefined;
    }

    const canonical = this.resolveCanonicalPreactSpecifier(specifier);
    if (!canonical) {
      return undefined;
    }

    const localFileUrl = await this.resolveNodeSpecifierToFileUrl(canonical);
    if (!localFileUrl) {
      return undefined;
    }

    return localFileUrl;
  }

  private resolveCanonicalPreactSpecifier(
    specifier: string,
  ): string | undefined {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const directAliases = new Map<string, string>([
      ["preact", "preact"],
      ["preact/hooks", "preact/hooks"],
      ["preact/jsx-runtime", "preact/jsx-runtime"],
      ["preact/compat", "preact/compat"],
      ["react", "preact/compat"],
      ["react-dom", "preact/compat"],
      ["react-dom/client", "preact/compat"],
      ["react/jsx-runtime", "preact/jsx-runtime"],
      ["react/jsx-dev-runtime", "preact/jsx-runtime"],
    ]);
    const mapped = directAliases.get(trimmed);
    if (mapped) {
      return mapped;
    }

    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      return undefined;
    }

    const aliasedReact = this.resolveAliasedReactRemoteSpecifier(trimmed);
    if (aliasedReact) {
      return aliasedReact;
    }

    const lower = trimmed.toLowerCase();
    if (!lower.includes("preact@")) {
      return undefined;
    }

    if (
      lower.includes("/hooks/") ||
      lower.endsWith("/hooks") ||
      lower.endsWith("/hooks.mjs") ||
      lower.includes("/hooks?")
    ) {
      return "preact/hooks";
    }
    if (
      lower.includes("/jsx-runtime/") ||
      lower.includes("/jsx-runtime.mjs") ||
      lower.includes("jsxruntime")
    ) {
      return "preact/jsx-runtime";
    }
    if (
      lower.includes("/compat/") ||
      lower.endsWith("/compat") ||
      lower.endsWith("/compat.mjs")
    ) {
      return "preact/compat";
    }
    if (
      lower.includes("/dist/preact") ||
      /\/preact@[^/?#]+(?:[?#]|$)/.test(lower)
    ) {
      return "preact";
    }
    return undefined;
  }

  private resolveAliasedReactRemoteSpecifier(
    specifier: string,
  ): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(specifier);
    } catch {
      return undefined;
    }

    if (parsed.hostname.toLowerCase() !== "esm.sh") {
      return undefined;
    }

    const aliases = (parsed.searchParams.get("alias") ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase());
    const pathname = decodeURIComponent(parsed.pathname).replace(
      /^\/(?:v\d+|stable)\//,
      "/",
    );
    const reactMatch = /^\/react@[^/]+(?:\/(jsx-(?:dev-)?runtime))?\/?$/.exec(
      pathname,
    );
    if (reactMatch && aliases.includes("react:preact/compat")) {
      return reactMatch[1] ? "preact/jsx-runtime" : "preact/compat";
    }

    if (
      /^\/react-dom@[^/]+(?:\/client)?\/?$/.test(pathname) &&
      aliases.includes("react-dom:preact/compat")
    ) {
      return "preact/compat";
    }

    return undefined;
  }

  private async resolveNodeSpecifierToFileUrl(
    specifier: string,
  ): Promise<string | undefined> {
    const cached = this.localNodeSpecifierUrlCache.get(specifier);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const pathToFileUrl = await this.getNodePathToFileUrl();
    if (!pathToFileUrl) {
      setMapEntryWithLimit(
        this.localNodeSpecifierUrlCache,
        specifier,
        null,
        this.localNodeSpecifierUrlCacheMaxEntries,
      );
      return undefined;
    }

    const preferredPreactPath =
      await this.resolvePreferredLocalPreactEsmPath(specifier);
    if (preferredPreactPath) {
      const resolvedUrl = pathToFileUrl(preferredPreactPath).toString();
      setMapEntryWithLimit(
        this.localNodeSpecifierUrlCache,
        specifier,
        resolvedUrl,
        this.localNodeSpecifierUrlCacheMaxEntries,
      );
      return resolvedUrl;
    }

    const moduleResolver = await this.getNodeModuleResolver();
    if (!moduleResolver) {
      setMapEntryWithLimit(
        this.localNodeSpecifierUrlCache,
        specifier,
        null,
        this.localNodeSpecifierUrlCacheMaxEntries,
      );
      return undefined;
    }

    try {
      const resolvedPath = moduleResolver.resolve(specifier);
      const resolvedUrl = pathToFileUrl(resolvedPath).toString();
      setMapEntryWithLimit(
        this.localNodeSpecifierUrlCache,
        specifier,
        resolvedUrl,
        this.localNodeSpecifierUrlCacheMaxEntries,
      );
      return resolvedUrl;
    } catch {
      setMapEntryWithLimit(
        this.localNodeSpecifierUrlCache,
        specifier,
        null,
        this.localNodeSpecifierUrlCacheMaxEntries,
      );
      return undefined;
    }
  }

  private async resolvePreferredLocalPreactEsmPath(
    specifier: string,
  ): Promise<string | undefined> {
    const relativeEntry = PREACT_LOCAL_ESM_ENTRYPOINTS.get(specifier);
    if (!relativeEntry) {
      return undefined;
    }

    const preactRoot = await this.getPreactPackageRoot();
    const pathModule = await this.getNodePathModule();
    const fsModule = await this.getNodeFsModule();
    if (!preactRoot || !pathModule || !fsModule) {
      return undefined;
    }

    const candidatePath = pathModule.join(preactRoot, relativeEntry);
    if (!fsModule.existsSync(candidatePath)) {
      return undefined;
    }

    return candidatePath;
  }

  private async getNodeModuleResolver(): Promise<
    NodeModuleResolver | undefined
  > {
    if (this.nodeModuleResolverPromise) {
      return this.nodeModuleResolverPromise;
    }

    this.nodeModuleResolverPromise = (async () => {
      if (!isNodeRuntime()) {
        return undefined;
      }

      try {
        const moduleNamespace = (await import("node:module")) as {
          createRequire?: (filename: string) => NodeModuleResolver;
        };
        if (typeof moduleNamespace.createRequire !== "function") {
          return undefined;
        }

        const cwd =
          typeof process.cwd === "function" ? process.cwd() : "/tmp/renderify";
        return moduleNamespace.createRequire(
          `${cwd}/__renderify_runtime_source_loader__.cjs`,
        );
      } catch {
        return undefined;
      }
    })();

    return this.nodeModuleResolverPromise;
  }

  private async getNodePathToFileUrl(): Promise<NodePathToFileUrl | undefined> {
    if (this.nodePathToFileUrlPromise) {
      return this.nodePathToFileUrlPromise;
    }

    this.nodePathToFileUrlPromise = (async () => {
      if (!isNodeRuntime()) {
        return undefined;
      }

      try {
        const urlNamespace = (await import("node:url")) as {
          pathToFileURL?: NodePathToFileUrl;
        };
        if (typeof urlNamespace.pathToFileURL !== "function") {
          return undefined;
        }
        return urlNamespace.pathToFileURL;
      } catch {
        return undefined;
      }
    })();

    return this.nodePathToFileUrlPromise;
  }

  private async getNodePathModule(): Promise<NodePathModule | undefined> {
    if (this.nodePathModulePromise) {
      return this.nodePathModulePromise;
    }

    this.nodePathModulePromise = (async () => {
      if (!isNodeRuntime()) {
        return undefined;
      }

      try {
        const pathNamespace = (await import("node:path")) as {
          dirname?: NodePathModule["dirname"];
          join?: NodePathModule["join"];
        };
        if (
          typeof pathNamespace.dirname !== "function" ||
          typeof pathNamespace.join !== "function"
        ) {
          return undefined;
        }
        return {
          dirname: pathNamespace.dirname,
          join: pathNamespace.join,
        };
      } catch {
        return undefined;
      }
    })();

    return this.nodePathModulePromise;
  }

  private async getNodeFsModule(): Promise<NodeFsModule | undefined> {
    if (this.nodeFsModulePromise) {
      return this.nodeFsModulePromise;
    }

    this.nodeFsModulePromise = (async () => {
      if (!isNodeRuntime()) {
        return undefined;
      }

      try {
        const fsNamespace = (await import("node:fs")) as {
          existsSync?: NodeFsModule["existsSync"];
        };
        if (typeof fsNamespace.existsSync !== "function") {
          return undefined;
        }
        return {
          existsSync: fsNamespace.existsSync,
        };
      } catch {
        return undefined;
      }
    })();

    return this.nodeFsModulePromise;
  }

  private async getPreactPackageRoot(): Promise<string | undefined> {
    if (this.preactPackageRootPromise) {
      return this.preactPackageRootPromise;
    }

    this.preactPackageRootPromise = (async () => {
      const moduleResolver = await this.getNodeModuleResolver();
      const pathModule = await this.getNodePathModule();
      if (!moduleResolver || !pathModule) {
        return undefined;
      }

      try {
        const packageJsonPath = moduleResolver.resolve("preact/package.json");
        return pathModule.dirname(packageJsonPath);
      } catch {
        return undefined;
      }
    })();

    return this.preactPackageRootPromise;
  }

  private stripSourceMapDirectives(code: string): string {
    // Source-map directives from remote bundles often reference relative .map
    // files, which break when modules are rematerialized as data: URLs.
    const withoutLineComments = code.replace(
      /^[ \t]*\/\/[#@]\s*sourceMappingURL=.*$/gm,
      "",
    );
    return withoutLineComments.replace(
      /\/\*[#@]\s*sourceMappingURL=[^*]*\*\//g,
      "",
    );
  }

  private async verifyFetchedModuleIntegrity(
    fetched: RemoteModuleFetchResult,
  ): Promise<void> {
    const expectedIntegrity = this.resolveExpectedIntegrity(
      fetched.originalUrl,
      fetched.requestUrl,
      fetched.url,
    );
    if (!expectedIntegrity) {
      return;
    }

    const verified = await verifyModuleIntegrity({
      content: fetched.code,
      integrity: expectedIntegrity,
    });
    if (verified) {
      return;
    }

    this.diagnostics.push({
      level: "error",
      code: "RUNTIME_SOURCE_INTEGRITY_FAILED",
      message: `Runtime source module integrity mismatch: ${fetched.url}`,
    });
    throw new RuntimeModuleIntegrityError(fetched.originalUrl ?? fetched.url);
  }

  private resolveExpectedIntegrity(
    ...urls: Array<string | undefined>
  ): string | undefined {
    for (const url of urls) {
      if (!url) {
        continue;
      }
      const integrity = this.integrityByResolvedUrl.get(url.trim());
      if (integrity) {
        return integrity;
      }
    }
    return undefined;
  }

  private registerMaterializationDependency(
    parentKey: string,
    childKey: string,
  ): () => void {
    const pathToParent = findMaterializationDependencyPath(
      this.materializationDependencyGraph,
      childKey,
      parentKey,
    );
    if (pathToParent) {
      const cycle = [parentKey, ...pathToParent]
        .map(materializedCacheKeyToUrl)
        .join(" -> ");
      const message = `Circular remote module dependency is unsupported: ${cycle}`;
      this.diagnostics.push({
        level: "error",
        code: "RUNTIME_SOURCE_IMPORT_CYCLE",
        message,
      });
      throw new Error(message);
    }

    let children = this.materializationDependencyGraph.get(parentKey);
    if (!children) {
      children = new Map<string, number>();
      this.materializationDependencyGraph.set(parentKey, children);
    }
    children.set(childKey, (children.get(childKey) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const currentChildren =
        this.materializationDependencyGraph.get(parentKey);
      const count = currentChildren?.get(childKey);
      if (!currentChildren || count === undefined) {
        return;
      }
      if (count > 1) {
        currentChildren.set(childKey, count - 1);
        return;
      }

      currentChildren.delete(childKey);
      if (currentChildren.size === 0) {
        this.materializationDependencyGraph.delete(parentKey);
      }
    };
  }

  private createMaterializedCacheKey(
    url: string,
    integrity: string | undefined,
  ): string {
    return integrity ? `${url}\u0000integrity:${integrity}` : url;
  }
}

function getMaterializationDependencyGraph(
  inflight: Map<string, Promise<string>>,
): MaterializationDependencyGraph {
  const existing = MATERIALIZATION_DEPENDENCY_GRAPHS.get(inflight);
  if (existing) {
    return existing;
  }

  const created: MaterializationDependencyGraph = new Map();
  MATERIALIZATION_DEPENDENCY_GRAPHS.set(inflight, created);
  return created;
}

function findMaterializationDependencyPath(
  graph: MaterializationDependencyGraph,
  from: string,
  to: string,
): string[] | undefined {
  if (from === to) {
    return [from];
  }

  const pending: Array<{ key: string; path: string[] }> = [
    { key: from, path: [from] },
  ];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.key)) {
      continue;
    }
    visited.add(current.key);

    for (const child of graph.get(current.key)?.keys() ?? []) {
      const path = [...current.path, child];
      if (child === to) {
        return path;
      }
      if (!visited.has(child)) {
        pending.push({ key: child, path });
      }
    }
  }

  return undefined;
}

function materializedCacheKeyToUrl(cacheKey: string): string {
  return cacheKey.split("\u0000integrity:", 1)[0] ?? cacheKey;
}

function normalizeCacheMaxEntries(value: number | undefined, fallback: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return fallback;
  }

  return value;
}

function setMapEntryWithLimit<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maxEntries: number,
): void {
  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

function collectIntegrityByResolvedUrl(
  moduleManifest: RuntimeModuleManifest | undefined,
): Map<string, string> {
  const mapped = new Map<string, string>();
  if (!moduleManifest) {
    return mapped;
  }

  for (const descriptor of Object.values(moduleManifest)) {
    if (
      typeof descriptor.resolvedUrl !== "string" ||
      typeof descriptor.integrity !== "string"
    ) {
      continue;
    }

    const resolvedUrl = descriptor.resolvedUrl.trim();
    const integrity = descriptor.integrity.trim();
    if (resolvedUrl.length === 0 || integrity.length === 0) {
      continue;
    }

    mapped.set(resolvedUrl, integrity);
  }

  return mapped;
}

function resolveManifestPreactVersion(
  moduleManifest: RuntimeModuleManifest | undefined,
): string | undefined {
  if (!moduleManifest) {
    return undefined;
  }

  for (const specifier of [
    "preact",
    "preact/hooks",
    "preact/jsx-runtime",
    "preact/compat",
  ]) {
    const descriptor = moduleManifest[specifier];
    const declaredVersion = descriptor?.version?.trim();
    if (
      declaredVersion &&
      /^[0-9]+(?:\.[0-9A-Za-z-]+){1,3}$/.test(declaredVersion)
    ) {
      return declaredVersion;
    }

    const resolvedUrl = descriptor?.resolvedUrl?.trim();
    const resolvedVersion = resolvedUrl?.match(
      /(?:\/|npm:)preact@([^/?#]+)/i,
    )?.[1];
    if (
      resolvedVersion &&
      /^[0-9]+(?:\.[0-9A-Za-z-]+){1,3}$/.test(resolvedVersion)
    ) {
      return resolvedVersion;
    }
  }

  return undefined;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
