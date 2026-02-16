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
import { isBrowserRuntime, isNodeRuntime } from "./runtime-environment";
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
  isRemoteUrlAllowed?: (url: string) => boolean;
}

type NodeModuleResolver = {
  resolve(specifier: string): string;
};

type NodePathToFileUrl = (path: string) => URL;
type NodePathModule = {
  dirname(path: string): string;
  join(...segments: string[]): string;
};

const PREACT_LOCAL_ESM_ENTRYPOINTS = new Map<string, string>([
  ["preact", "dist/preact.mjs"],
  ["preact/hooks", "hooks/dist/hooks.mjs"],
  ["preact/jsx-runtime", "jsx-runtime/dist/jsxRuntime.mjs"],
  ["preact/compat", "compat/dist/compat.mjs"],
]);

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
  private readonly isRemoteUrlAllowedFn: (url: string) => boolean;
  private readonly localNodeSpecifierUrlCache = new Map<
    string,
    string | null
  >();
  private nodeModuleResolverPromise?: Promise<NodeModuleResolver | undefined>;
  private nodePathToFileUrlPromise?: Promise<NodePathToFileUrl | undefined>;
  private nodePathModulePromise?: Promise<NodePathModule | undefined>;
  private preactPackageRootPromise?: Promise<string | undefined>;

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
    this.isRemoteUrlAllowedFn = options.isRemoteUrlAllowed ?? (() => true);
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

    const localPreact = await this.resolveLocalPreactSpecifier(trimmed);
    if (localPreact) {
      return localPreact;
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
      const localFromAbsolute =
        await this.resolveLocalPreactSpecifier(absolute);
      if (localFromAbsolute) {
        return localFromAbsolute;
      }
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
    const localFromResolved = await this.resolveLocalPreactSpecifier(resolved);
    if (localFromResolved) {
      return localFromResolved;
    }

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
      const localFromAbsolute =
        await this.resolveLocalPreactSpecifier(absolute);
      if (localFromAbsolute) {
        return localFromAbsolute;
      }
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

    if (isBrowserRuntime() && this.shouldPreserveRemoteImport(normalizedUrl)) {
      if (!this.isRemoteImportAllowed(normalizedUrl)) {
        throw new Error(
          `Remote module URL is blocked by runtime network policy: ${normalizedUrl}`,
        );
      }
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

    const code = this.stripSourceMapDirectives(fetched.code);

    return this.rewriteImportsAsyncFn(code, async (childSpecifier) =>
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

    const filteredAttempts = this.filterDisallowedAttempts(attempts);
    if (filteredAttempts.length === 0) {
      throw new Error(
        `Remote module URL is blocked by runtime network policy: ${url}`,
      );
    }

    const hedgeDelayMs = Math.max(
      50,
      Math.min(300, this.remoteFetchBackoffMs || 100),
    );
    const fetchTasks = filteredAttempts.map((attempt, index) =>
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

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private shouldPreserveRemoteImport(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    const path = parsed.pathname.toLowerCase();
    return (
      path.includes("/npm:preact@") ||
      path.includes("/npm:preact-render-to-string@")
    );
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

    const lower = trimmed.toLowerCase();
    if (!lower.includes("preact@")) {
      return undefined;
    }

    if (lower.includes("/hooks/")) {
      return "preact/hooks";
    }
    if (lower.includes("/jsx-runtime/") || lower.includes("jsxruntime")) {
      return "preact/jsx-runtime";
    }
    if (lower.includes("/compat/")) {
      return "preact/compat";
    }
    if (lower.includes("/dist/preact")) {
      return "preact";
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
      this.localNodeSpecifierUrlCache.set(specifier, null);
      return undefined;
    }

    const preferredPreactPath =
      await this.resolvePreferredLocalPreactEsmPath(specifier);
    if (preferredPreactPath) {
      const resolvedUrl = pathToFileUrl(preferredPreactPath).toString();
      this.localNodeSpecifierUrlCache.set(specifier, resolvedUrl);
      return resolvedUrl;
    }

    const moduleResolver = await this.getNodeModuleResolver();
    if (!moduleResolver) {
      this.localNodeSpecifierUrlCache.set(specifier, null);
      return undefined;
    }

    try {
      const resolvedPath = moduleResolver.resolve(specifier);
      const resolvedUrl = pathToFileUrl(resolvedPath).toString();
      this.localNodeSpecifierUrlCache.set(specifier, resolvedUrl);
      return resolvedUrl;
    } catch {
      this.localNodeSpecifierUrlCache.set(specifier, null);
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
    if (!preactRoot || !pathModule) {
      return undefined;
    }

    return pathModule.join(preactRoot, relativeEntry);
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
}
