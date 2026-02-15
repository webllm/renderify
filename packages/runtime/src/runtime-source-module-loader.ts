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
  type RemoteModuleFetchResult,
} from "./module-fetch";
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
  canMaterializeRuntimeModules: () => boolean;
  rewriteImportsAsync: (
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ) => Promise<string>;
  createInlineModuleUrl: (code: string) => string;
  resolveRuntimeSourceSpecifier: (
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest?: boolean,
  ) => string;
}

export class RuntimeSourceModuleLoader {
  private readonly moduleManifest: RuntimeModuleManifest | undefined;
  private readonly diagnostics: RuntimeDiagnostic[];
  private readonly materializedModuleUrlCache: Map<string, string>;
  private readonly materializedModuleInflight: Map<string, Promise<string>>;
  private readonly remoteFallbackCdnBases: string[];
  private readonly remoteFetchTimeoutMs: number;
  private readonly remoteFetchRetries: number;
  private readonly remoteFetchBackoffMs: number;
  private readonly canMaterializeRuntimeModulesFn: () => boolean;
  private readonly rewriteImportsAsyncFn: (
    code: string,
    resolver: (specifier: string) => Promise<string>,
  ) => Promise<string>;
  private readonly createInlineModuleUrlFn: (code: string) => string;
  private readonly resolveRuntimeSourceSpecifierFn: (
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    requireManifest?: boolean,
  ) => string;

  constructor(options: RuntimeSourceModuleLoaderOptions) {
    this.moduleManifest = options.moduleManifest;
    this.diagnostics = options.diagnostics;
    this.materializedModuleUrlCache = options.materializedModuleUrlCache;
    this.materializedModuleInflight = options.materializedModuleInflight;
    this.remoteFallbackCdnBases = options.remoteFallbackCdnBases;
    this.remoteFetchTimeoutMs = options.remoteFetchTimeoutMs;
    this.remoteFetchRetries = options.remoteFetchRetries;
    this.remoteFetchBackoffMs = options.remoteFetchBackoffMs;
    this.canMaterializeRuntimeModulesFn = options.canMaterializeRuntimeModules;
    this.rewriteImportsAsyncFn = options.rewriteImportsAsync;
    this.createInlineModuleUrlFn = options.createInlineModuleUrl;
    this.resolveRuntimeSourceSpecifierFn =
      options.resolveRuntimeSourceSpecifier;
  }

  async importSourceModuleFromCode(code: string): Promise<unknown> {
    if (this.canMaterializeRuntimeModulesFn()) {
      const rewrittenEntry = await this.rewriteImportsAsyncFn(
        code,
        async (specifier) =>
          this.resolveRuntimeImportSpecifier(specifier, undefined),
      );
      const entryUrl = this.createInlineModuleUrlFn(rewrittenEntry);
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
  ): Promise<string> {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return trimmed;
    }

    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
      return trimmed;
    }

    if (isHttpUrl(trimmed)) {
      return this.materializeRemoteModule(trimmed);
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
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeRemoteModule(absolute);
    }

    const resolved = this.resolveRuntimeSourceSpecifierFn(
      trimmed,
      this.moduleManifest,
      this.diagnostics,
      false,
    );

    if (isHttpUrl(resolved)) {
      return this.materializeRemoteModule(resolved);
    }

    if (
      (resolved.startsWith("./") ||
        resolved.startsWith("../") ||
        resolved.startsWith("/")) &&
      parentUrl &&
      isHttpUrl(parentUrl)
    ) {
      const absolute = new URL(resolved, parentUrl).toString();
      if (!isHttpUrl(absolute)) {
        return absolute;
      }

      return this.materializeRemoteModule(absolute);
    }

    return resolved;
  }

  async materializeRemoteModule(url: string): Promise<string> {
    const normalizedUrl = url.trim();
    if (normalizedUrl.length === 0) {
      return normalizedUrl;
    }

    const cachedUrl = this.materializedModuleUrlCache.get(normalizedUrl);
    if (cachedUrl) {
      return cachedUrl;
    }

    const inflight = this.materializedModuleInflight.get(normalizedUrl);
    if (inflight) {
      return inflight;
    }

    const loading = (async () => {
      const fetched =
        await this.fetchRemoteModuleCodeWithFallback(normalizedUrl);
      const rewritten = await this.materializeFetchedModuleSource(fetched);

      const inlineUrl = this.createInlineModuleUrlFn(rewritten);
      this.materializedModuleUrlCache.set(normalizedUrl, inlineUrl);
      this.materializedModuleUrlCache.set(fetched.url, inlineUrl);
      return inlineUrl;
    })();

    this.materializedModuleInflight.set(normalizedUrl, loading);
    try {
      return await loading;
    } finally {
      this.materializedModuleInflight.delete(normalizedUrl);
    }
  }

  async materializeFetchedModuleSource(
    fetched: RemoteModuleFetchResult,
  ): Promise<string> {
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

    return this.rewriteImportsAsyncFn(fetched.code, async (childSpecifier) =>
      this.resolveRuntimeImportSpecifier(childSpecifier, fetched.url),
    );
  }

  async fetchRemoteModuleCodeWithFallback(
    url: string,
  ): Promise<RemoteModuleFetchResult> {
    const attempts = buildRemoteModuleAttemptUrls(
      url,
      this.remoteFallbackCdnBases,
    );

    if (attempts.length === 0) {
      throw new Error(`Failed to load module: ${url}`);
    }

    const hedgeDelayMs = Math.max(
      50,
      Math.min(300, this.remoteFetchBackoffMs || 100),
    );
    const fetchTasks = attempts.map((attempt, index) =>
      this.fetchRemoteModuleAttemptWithRetries(
        attempt,
        url,
        index === 0 ? 0 : hedgeDelayMs * index,
      ),
    );

    try {
      return await Promise.any(fetchTasks);
    } catch (error) {
      if (error instanceof AggregateError && error.errors.length > 0) {
        throw error.errors[error.errors.length - 1];
      }

      throw error;
    }
  }

  private async fetchRemoteModuleAttemptWithRetries(
    attempt: string,
    originalUrl: string,
    startDelayMs: number,
  ): Promise<RemoteModuleFetchResult> {
    if (startDelayMs > 0) {
      await delay(startDelayMs);
    }

    let lastError: unknown;
    for (let retry = 0; retry <= this.remoteFetchRetries; retry += 1) {
      try {
        const response = await fetchWithTimeout(
          attempt,
          this.remoteFetchTimeoutMs,
        );
        if (!response.ok) {
          throw new Error(
            `Failed to load module ${attempt}: HTTP ${response.status}`,
          );
        }

        if (attempt !== originalUrl) {
          this.diagnostics.push({
            level: "warning",
            code: "RUNTIME_SOURCE_IMPORT_FALLBACK_USED",
            message: `Loaded module via fallback URL: ${originalUrl} -> ${attempt}`,
          });
        }

        if (retry > 0) {
          this.diagnostics.push({
            level: "warning",
            code: "RUNTIME_SOURCE_IMPORT_RETRY_SUCCEEDED",
            message: `Recovered remote module after retry ${retry}: ${attempt}`,
          });
        }

        return {
          url: response.url || attempt,
          code: await response.text(),
          contentType:
            response.headers.get("content-type")?.toLowerCase() ?? "",
          requestUrl: attempt,
        };
      } catch (error) {
        lastError = error;
        if (retry >= this.remoteFetchRetries) {
          break;
        }
        await delay(this.remoteFetchBackoffMs * Math.max(1, retry + 1));
      }
    }

    throw lastError ?? new Error(`Failed to load module: ${attempt}`);
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

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
