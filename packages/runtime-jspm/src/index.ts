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

const JSPM_SPECIFIER_OVERRIDES: Record<string, string> = {
  preact: "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  "preact/hooks":
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
  "preact/compat":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "preact/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  react: "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom/client":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  "react/jsx-dev-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  recharts: "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
};

export class JspmModuleLoader implements RuntimeModuleLoader {
  private readonly cdnBaseUrl: string;
  private readonly importMap: Record<string, string>;
  private readonly cache = new Map<string, unknown>();

  constructor(options: JspmModuleLoaderOptions = {}) {
    this.cdnBaseUrl = this.normalizeCdnBaseUrl(options.cdnBaseUrl);
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
      return this.resolveNpmSpecifier(specifier.slice(4));
    }

    if (specifier.startsWith("@") || /^[a-zA-Z0-9_-]+/.test(specifier)) {
      return this.resolveNpmSpecifier(specifier);
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

  private resolveNpmSpecifier(specifier: string): string {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      throw new Error("Empty npm specifier is not supported");
    }

    const override = JSPM_SPECIFIER_OVERRIDES[normalized];
    if (override) {
      return override;
    }

    return `${this.cdnBaseUrl}/npm:${this.withDefaultEntry(normalized)}`;
  }

  private withDefaultEntry(specifier: string): string {
    if (/\.[mc]?js$/i.test(specifier)) {
      return specifier;
    }

    if (specifier.startsWith("@")) {
      const secondSlash = specifier.indexOf("/", 1);
      if (secondSlash === -1) {
        return `${specifier}/index.js`;
      }

      const subpathSlash = specifier.indexOf("/", secondSlash + 1);
      if (subpathSlash === -1) {
        return `${specifier}/index.js`;
      }

      return `${specifier}.js`;
    }

    if (!specifier.includes("/")) {
      return `${specifier}/index.js`;
    }

    return `${specifier}.js`;
  }

  private normalizeCdnBaseUrl(input?: string): string {
    const raw = input?.trim() || "https://ga.jspm.io";
    const normalized = raw.replace(/\/$/, "");
    return normalized.endsWith("/npm")
      ? normalized.slice(0, normalized.length - 4)
      : normalized;
  }
}
