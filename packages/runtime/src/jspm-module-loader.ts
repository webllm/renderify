import { DEFAULT_JSPM_SPECIFIER_OVERRIDES } from "@renderify/ir";
import type { RuntimeModuleLoader } from "./index";

export interface JspmModuleLoaderOptions {
  cdnBaseUrl?: string;
  importMap?: Record<string, string>;
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
}
