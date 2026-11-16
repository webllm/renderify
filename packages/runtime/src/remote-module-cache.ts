/**
 * Document-wide cache of remote module responses. Content at a version-pinned
 * CDN URL (`npm:preact@10.28.3/...`, `esm.sh/react@19.2.0?...`) never changes,
 * so it is kept for the life of the document; responses for ranges and tags
 * (`@^11.5.0`, `@latest`) are reused for a few minutes. Dependency preflight,
 * materialization, and later renders share one network fetch, and concurrent
 * requests share one in-flight fetch. Callers still apply their own policy,
 * pinning, integrity, and size checks to every cached response.
 */

export interface CachedRemoteModuleResponse {
  url: string;
  code: string;
  contentType: string;
}

const MAX_CACHED_BYTES = 48 * 1024 * 1024;
const MUTABLE_RESPONSE_TTL_MS = 10 * 60 * 1000;
const PINNED_PACKAGE_SEGMENT =
  /(?:^|\/)(?:npm:)?(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\/|$)/;

const responses = new Map<string, Promise<CachedRemoteModuleResponse>>();
const sizes = new Map<string, number>();
const expiries = new Map<string, number>();
let cachedBytes = 0;

/** Whether a URL names an exact package version over HTTPS. */
export function isImmutableRemoteModuleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      PINNED_PACKAGE_SEGMENT.test(decodeURIComponent(parsed.pathname))
    );
  } catch {
    return false;
  }
}

/**
 * Returns the cached response for an https `url`, or runs `load` and caches
 * its result. Failed or aborted loads are not cached.
 */
export async function loadSharedRemoteModule(
  url: string,
  load: () => Promise<CachedRemoteModuleResponse>,
): Promise<CachedRemoteModuleResponse> {
  if (!isHttpsUrl(url)) {
    return load();
  }

  const expiresAt = expiries.get(url);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    forget(url);
  }

  const existing = responses.get(url);
  if (existing) {
    try {
      const value = await existing;
      // Refresh recency for LRU eviction.
      if (responses.get(url) === existing) {
        responses.delete(url);
        responses.set(url, existing);
      }
      return value;
    } catch {
      // That attempt failed or its caller aborted; load it ourselves.
    }
  }

  const pending = load();
  responses.set(url, pending);
  expiries.set(
    url,
    isImmutableRemoteModuleUrl(url)
      ? Number.POSITIVE_INFINITY
      : Date.now() + MUTABLE_RESPONSE_TTL_MS,
  );
  pending.then(
    (value) => {
      if (responses.get(url) !== pending) {
        return;
      }
      const size = value.code.length * 2;
      sizes.set(url, size);
      cachedBytes += size;
      evict();
    },
    () => {
      if (responses.get(url) === pending) {
        forget(url);
      }
    },
  );
  return pending;
}

/** Drops every cached response. Mainly for tests and memory pressure. */
export function clearRemoteModuleCache(): void {
  responses.clear();
  sizes.clear();
  expiries.clear();
  cachedBytes = 0;
}

export function getRemoteModuleCacheStats(): {
  entries: number;
  bytes: number;
} {
  return { entries: responses.size, bytes: cachedBytes };
}

function forget(url: string): void {
  responses.delete(url);
  expiries.delete(url);
  const size = sizes.get(url);
  if (size !== undefined) {
    sizes.delete(url);
    cachedBytes -= size;
  }
}

function evict(): void {
  for (const url of responses.keys()) {
    if (cachedBytes <= MAX_CACHED_BYTES) {
      return;
    }
    if (sizes.has(url)) {
      forget(url);
    }
  }
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
