import { isBrowserRuntime, nowMs } from "./runtime-environment";
import type {
  RuntimeSourceTranspileInput,
  RuntimeSourceTranspiler,
} from "./runtime-manager.types";
import type { RuntimeSourceJsxHelperMode } from "./runtime-source-runtime";

interface BabelStandaloneLike {
  transform(
    code: string,
    options: {
      sourceType?: "module";
      presets?: unknown[];
      filename?: string;
      babelrc?: boolean;
      configFile?: boolean;
      comments?: boolean;
    },
  ): {
    code?: string;
  };
}

interface EsbuildTransformResultLike {
  code?: string;
}

interface EsbuildLikeModule {
  transform(
    code: string,
    options: {
      loader: "js" | "jsx" | "ts" | "tsx";
      format: "esm";
      target: "es2022";
      sourcefile?: string;
      sourcemap: false;
      jsx?: "automatic" | "transform";
      jsxImportSource?: string;
      jsxFactory?: string;
      jsxFragment?: string;
    },
  ): Promise<EsbuildTransformResultLike>;
}

const RUNTIME_JSX_HELPERS = `
function __renderify_runtime_to_nodes(value) {
  if (value === null || value === undefined || value === false || value === true) {
    return [];
  }
  if (Array.isArray(value)) {
    const flattened = [];
    for (const entry of value) {
      flattened.push(...__renderify_runtime_to_nodes(entry));
    }
    return flattened;
  }
  if (typeof value === "string" || typeof value === "number") {
    return [{ type: "text", value: String(value) }];
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  ) {
    return [value];
  }
  return [{ type: "text", value: String(value) }];
}

function __renderify_runtime_h(type, props, ...children) {
  const normalizedChildren = __renderify_runtime_to_nodes(children);
  if (typeof type === "function") {
    const output = type({ ...(props || {}), children: normalizedChildren });
    const functionNodes = __renderify_runtime_to_nodes(output);
    if (functionNodes.length === 1) {
      return functionNodes[0];
    }
    return { type: "element", tag: "div", children: functionNodes };
  }
  if (typeof type === "string") {
    return {
      type: "element",
      tag: type,
      props: props || undefined,
      children: normalizedChildren,
    };
  }
  return { type: "text", value: "Unsupported JSX node type" };
}

function __renderify_runtime_fragment(...children) {
  return __renderify_runtime_to_nodes(children);
}
`.trim();
const DEFAULT_TRANSPILE_CACHE_MAX_ENTRIES = 256;

export interface RuntimeSourceTranspileDurationMetrics {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export interface RuntimeSourceTranspileMetrics {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  babelTranspiles: number;
  esbuildFallbackTranspiles: number;
  duration: RuntimeSourceTranspileDurationMetrics;
}

export class BabelRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    if (input.language === "js") {
      return input.code;
    }

    const babel = this.resolveBabel();
    const presets: unknown[] = [];

    if (input.language === "ts" || input.language === "tsx") {
      presets.push("typescript");
    }

    if (input.language === "jsx" || input.language === "tsx") {
      if (input.runtime === "preact") {
        presets.push([
          "react",
          {
            runtime: "automatic",
            importSource: "preact",
          },
        ]);
      } else {
        presets.push([
          "react",
          {
            runtime: "classic",
            pragma: "__renderify_runtime_h",
            pragmaFrag: "__renderify_runtime_fragment",
          },
        ]);
      }
    }

    const transformed = babel.transform(input.code, {
      sourceType: "module",
      presets,
      filename: input.filename,
      babelrc: false,
      configFile: false,
      comments: false,
    });

    if (!transformed.code) {
      throw new Error("Babel returned empty output");
    }

    return transformed.code;
  }

  private resolveBabel(): BabelStandaloneLike {
    const root = globalThis as unknown as {
      Babel?: BabelStandaloneLike;
    };

    if (root.Babel && typeof root.Babel.transform === "function") {
      return root.Babel;
    }

    throw new Error(
      "Babel standalone is not available. Load @babel/standalone in browser or provide sourceTranspiler.",
    );
  }

  static mergeRuntimeHelpers(
    source: RuntimeSourceTranspileInput["code"],
    runtime: RuntimeSourceTranspileInput["runtime"],
    mode: RuntimeSourceJsxHelperMode = "auto",
  ): string {
    if (mode === "never") {
      return source;
    }

    if (mode === "auto" && runtime === "preact") {
      return source;
    }

    return `${source}\n\n${RUNTIME_JSX_HELPERS}`;
  }
}

export class EsbuildRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  private esbuildPromise?: Promise<EsbuildLikeModule>;

  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    if (input.language === "js") {
      return input.code;
    }

    const esbuild = await this.resolveEsbuild();
    const transformed = await esbuild.transform(input.code, {
      loader: this.resolveLoader(input.language),
      format: "esm",
      target: "es2022",
      sourcefile: input.filename,
      sourcemap: false,
      ...this.resolveJsxTransformOptions(input),
    });

    if (!transformed.code) {
      throw new Error("esbuild returned empty output");
    }

    return transformed.code;
  }

  private resolveLoader(
    language: RuntimeSourceTranspileInput["language"],
  ): "js" | "jsx" | "ts" | "tsx" {
    if (language === "jsx") {
      return "jsx";
    }
    if (language === "ts") {
      return "ts";
    }
    if (language === "tsx") {
      return "tsx";
    }
    return "js";
  }

  private resolveJsxTransformOptions(input: RuntimeSourceTranspileInput): {
    jsx?: "automatic" | "transform";
    jsxImportSource?: string;
    jsxFactory?: string;
    jsxFragment?: string;
  } {
    if (input.language !== "jsx" && input.language !== "tsx") {
      return {};
    }

    if (input.runtime === "preact") {
      return {
        jsx: "automatic",
        jsxImportSource: "preact",
      };
    }

    return {
      jsx: "transform",
      jsxFactory: "__renderify_runtime_h",
      jsxFragment: "__renderify_runtime_fragment",
    };
  }

  private async resolveEsbuild(): Promise<EsbuildLikeModule> {
    if (!this.esbuildPromise) {
      this.esbuildPromise = (async () => {
        try {
          const dynamicImport = new Function(
            "specifier",
            "return import(specifier)",
          ) as (specifier: string) => Promise<unknown>;
          const mod = (await dynamicImport("esbuild")) as {
            transform?: EsbuildLikeModule["transform"];
            default?: {
              transform?: EsbuildLikeModule["transform"];
            };
          };
          const transform = mod.transform ?? mod.default?.transform;
          if (typeof transform !== "function") {
            throw new Error("esbuild.transform is not available");
          }

          return {
            transform,
          } satisfies EsbuildLikeModule;
        } catch (error) {
          throw new Error(
            `esbuild is not available for runtime source transpilation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      })();
    }

    return this.esbuildPromise;
  }
}

export class DefaultRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  private readonly babelTranspiler = new BabelRuntimeSourceTranspiler();
  private readonly esbuildTranspiler = new EsbuildRuntimeSourceTranspiler();
  private readonly transpileCache = new Map<string, string>();
  private metrics: RuntimeSourceTranspileMetrics = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    babelTranspiles: 0,
    esbuildFallbackTranspiles: 0,
    duration: {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      avgMs: 0,
    },
  };

  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    const startedAt = nowMs();
    this.metrics.requests += 1;
    const cacheKey = this.createCacheKey(input);
    const cached = this.transpileCache.get(cacheKey);
    if (cached !== undefined) {
      this.metrics.cacheHits += 1;
      this.promoteCachedTranspile(cacheKey, cached);
      this.recordDuration(nowMs() - startedAt);
      return cached;
    }
    this.metrics.cacheMisses += 1;

    let transpiled: string;
    try {
      transpiled = await this.babelTranspiler.transpile(input);
      this.metrics.babelTranspiles += 1;
    } catch (error) {
      if (!isMissingBabelStandaloneError(error)) {
        this.recordDuration(nowMs() - startedAt);
        throw error;
      }

      if (isBrowserRuntime()) {
        this.recordDuration(nowMs() - startedAt);
        throw error;
      }

      transpiled = await this.esbuildTranspiler.transpile(input);
      this.metrics.esbuildFallbackTranspiles += 1;
    }

    this.cacheTranspileOutput(cacheKey, transpiled);
    this.recordDuration(nowMs() - startedAt);
    return transpiled;
  }

  getMetrics(): RuntimeSourceTranspileMetrics {
    const duration = this.metrics.duration;
    return {
      ...this.metrics,
      duration: {
        count: duration.count,
        totalMs: duration.totalMs,
        minMs: Number.isFinite(duration.minMs) ? duration.minMs : 0,
        maxMs: duration.maxMs,
        avgMs: duration.avgMs,
      },
    };
  }

  resetMetrics(): void {
    this.metrics = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      babelTranspiles: 0,
      esbuildFallbackTranspiles: 0,
      duration: {
        count: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
        avgMs: 0,
      },
    };
  }

  private createCacheKey(input: RuntimeSourceTranspileInput): string {
    return [
      input.language,
      input.runtime ?? "",
      input.filename ?? "",
      input.code,
    ].join("\u0000");
  }

  private promoteCachedTranspile(cacheKey: string, output: string): void {
    this.transpileCache.delete(cacheKey);
    this.transpileCache.set(cacheKey, output);
  }

  private cacheTranspileOutput(cacheKey: string, output: string): void {
    this.transpileCache.set(cacheKey, output);
    if (this.transpileCache.size <= DEFAULT_TRANSPILE_CACHE_MAX_ENTRIES) {
      return;
    }

    const oldestKey = this.transpileCache.keys().next().value;
    if (oldestKey !== undefined) {
      this.transpileCache.delete(oldestKey);
    }
  }

  private recordDuration(durationMs: number): void {
    const normalizedDuration = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;
    const duration = this.metrics.duration;
    duration.count += 1;
    duration.totalMs += normalizedDuration;
    duration.minMs = Math.min(duration.minMs, normalizedDuration);
    duration.maxMs = Math.max(duration.maxMs, normalizedDuration);
    duration.avgMs = duration.totalMs / duration.count;
  }
}

function isMissingBabelStandaloneError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Babel standalone is not available")
  );
}
