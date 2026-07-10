import { createHash } from "node:crypto";
import { isAllowedNetworkUrl } from "@renderify/ir";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_CACHE_MAX_ENTRIES = 256;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PlaygroundIntegrityNetworkPolicy {
  allowArbitraryNetwork: boolean;
  allowedNetworkHosts: readonly string[];
}

export interface RemoteModuleIntegrityFetcherOptions {
  maxBytes?: number;
  maxRedirects?: number;
  cacheMaxEntries?: number;
}

export interface RemoteModuleIntegrityFetchOptions {
  timeoutMs: number;
  networkPolicy: PlaygroundIntegrityNetworkPolicy;
  fetchImpl?: typeof fetch;
}

interface IntegrityCacheEntry {
  effectiveUrl: string;
  integrity: string;
}

export class RemoteModuleIntegrityFetcher {
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly cacheMaxEntries: number;
  private readonly cache = new Map<string, IntegrityCacheEntry>();

  constructor(options: RemoteModuleIntegrityFetcherOptions = {}) {
    this.maxBytes = normalizePositiveInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
    );
    this.maxRedirects = normalizeNonNegativeInteger(
      options.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
    );
    this.cacheMaxEntries = normalizePositiveInteger(
      options.cacheMaxEntries,
      DEFAULT_CACHE_MAX_ENTRIES,
    );
  }

  async fetch(
    url: string,
    options: RemoteModuleIntegrityFetchOptions,
  ): Promise<string | undefined> {
    const initialUrl = parseHttpUrl(url);
    if (!initialUrl || !isUrlAllowed(initialUrl, options.networkPolicy)) {
      return undefined;
    }

    const cacheKey = createCacheKey(initialUrl, options.networkPolicy);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const cachedEffectiveUrl = parseHttpUrl(cached.effectiveUrl);
      if (
        cachedEffectiveUrl &&
        isUrlAllowed(cachedEffectiveUrl, options.networkPolicy)
      ) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return cached.integrity;
      }
      this.cache.delete(cacheKey);
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      normalizePositiveInteger(options.timeoutMs, 1),
    );

    try {
      let currentUrl = initialUrl;
      let redirects = 0;

      while (true) {
        if (!isUrlAllowed(currentUrl, options.networkPolicy)) {
          return undefined;
        }

        const response = await fetchImpl(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
        });
        const effectiveUrl = resolveEffectiveUrl(response, currentUrl);
        if (
          !effectiveUrl ||
          !isUrlAllowed(effectiveUrl, options.networkPolicy)
        ) {
          cancelResponseBody(response);
          return undefined;
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          cancelResponseBody(response);
          if (!location || redirects >= this.maxRedirects) {
            return undefined;
          }

          const redirectUrl = resolveRedirectUrl(location, effectiveUrl);
          if (
            !redirectUrl ||
            !isUrlAllowed(redirectUrl, options.networkPolicy)
          ) {
            return undefined;
          }

          redirects += 1;
          currentUrl = redirectUrl;
          continue;
        }

        if (!response.ok) {
          cancelResponseBody(response);
          return undefined;
        }

        const integrity = await hashBoundedResponse(response, this.maxBytes);
        if (!integrity) {
          return undefined;
        }

        this.setCache(cacheKey, {
          effectiveUrl: effectiveUrl.href,
          integrity,
        });
        return integrity;
      }
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private setCache(key: string, value: IntegrityCacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}

async function hashBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    cancelResponseBody(response);
    return undefined;
  }

  if (!response.body) {
    return `sha384-${createHash("sha384").digest("base64")}`;
  }

  const reader = response.body.getReader();
  const hash = createHash("sha384");
  let receivedBytes = 0;
  let complete = false;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }

      if (chunk.value.byteLength > maxBytes - receivedBytes) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      receivedBytes += chunk.value.byteLength;
      hash.update(chunk.value);
    }

    return `sha384-${hash.digest("base64")}`;
  } catch {
    if (!complete) {
      void reader.cancel().catch(() => {});
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function isUrlAllowed(
  url: URL,
  policy: PlaygroundIntegrityNetworkPolicy,
): boolean {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return false;
  }

  return (
    policy.allowArbitraryNetwork ||
    isAllowedNetworkUrl(url, [...policy.allowedNetworkHosts])
  );
}

function createCacheKey(
  url: URL,
  policy: PlaygroundIntegrityNetworkPolicy,
): string {
  const allowedHosts = [...policy.allowedNetworkHosts]
    .map((entry) => entry.trim().toLowerCase())
    .sort();
  return JSON.stringify([policy.allowArbitraryNetwork, allowedHosts, url.href]);
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveEffectiveUrl(
  response: Response,
  fallback: URL,
): URL | undefined {
  if (!response.url) {
    return fallback;
  }
  return parseHttpUrl(response.url);
}

function resolveRedirectUrl(location: string, baseUrl: URL): URL | undefined {
  try {
    const url = new URL(location, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function cancelResponseBody(response: Response): void {
  if (!response.body || response.body.locked) {
    return;
  }
  void response.body.cancel().catch(() => {});
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
