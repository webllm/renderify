import type { RuntimeModuleLoader } from "@renderify/runtime";

export interface JspmModuleLoaderOptions {
  cdnBaseUrl?: string;
  importMap?: Record<string, string>;
}

interface SystemLike {
  import(url: string): Promise<unknown>;
}

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
  private readonly cache = new Map<string, unknown>();

  constructor(options: JspmModuleLoaderOptions = {}) {
    this.cdnBaseUrl =
      options.cdnBaseUrl?.replace(/\/$/, "") ?? "https://ga.jspm.io/npm";
    this.importMap = options.importMap ?? {};
  }

  async load(specifier: string): Promise<unknown> {
    const resolved = this.resolveSpecifier(specifier);

    if (this.cache.has(resolved)) {
      return this.cache.get(resolved);
    }

    const loaded = await this.importWithBestEffort(resolved);
    this.cache.set(resolved, loaded);

    return loaded;
  }

  async unload(specifier: string): Promise<void> {
    const resolved = this.resolveSpecifier(specifier);
    this.cache.delete(resolved);
  }

  resolveSpecifier(specifier: string): string {
    const mapped = this.importMap[specifier];
    if (mapped) {
      return mapped;
    }

    if (this.isUrl(specifier)) {
      return specifier;
    }

    if (specifier.startsWith("npm:")) {
      return `${this.cdnBaseUrl}/${specifier.slice(4)}`;
    }

    if (specifier.startsWith("@") || /^[a-zA-Z0-9_-]+/.test(specifier)) {
      return `${this.cdnBaseUrl}/${specifier}`;
    }

    throw new Error(`Unsupported JSPM specifier: ${specifier}`);
  }

  private async importWithBestEffort(resolved: string): Promise<unknown> {
    const globalValue: unknown = globalThis;
    const maybeSystem =
      typeof globalValue === "object" && globalValue !== null
        ? (globalValue as Record<string, unknown>).System
        : undefined;

    if (hasSystemImport(maybeSystem)) {
      return maybeSystem.import(resolved);
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
}
