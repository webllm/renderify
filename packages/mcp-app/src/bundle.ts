/**
 * Node-only build helpers. These produce the browser-side runtime bundle used
 * by the self-contained shell tier. They are isolated here so that importing the
 * package's protocol/template/server surface never drags in esbuild.
 *
 * esbuild is a peer/optional dependency, loaded lazily. Servers typically call
 * `bundleBrowserRuntime()` once at startup and cache the result.
 */

export interface BundleResult {
  code: string;
  bytes: number;
}

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{
    outputFiles?: Array<{ text: string }>;
  }>;
}

async function loadEsbuild(): Promise<EsbuildLike> {
  try {
    const mod = (await import("esbuild")) as unknown as {
      default?: EsbuildLike;
    } & EsbuildLike;
    return (mod.default ?? mod) as EsbuildLike;
  } catch (error) {
    throw new Error(
      `@renderify/mcp-app self-contained bundling requires esbuild. Install it as a dependency. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

export interface BundleBrowserRuntimeOptions {
  /**
   * Module specifier or absolute path resolved to the runtime entry. Defaults
   * to `@renderify/runtime`. Tests/examples may point this at the source entry.
   */
  runtimeEntry?: string;
  /** Working directory esbuild resolves the entry from. Defaults to cwd. */
  resolveDir?: string;
  /** Minify the bundle. Defaults to true. */
  minify?: boolean;
}

/**
 * Bundle `@renderify/runtime` into a single classic-script IIFE that assigns the
 * runtime namespace to `globalThis.RenderifyRuntime`. No external imports remain
 * (preact, es-module-lexer, etc. are inlined), so the self-contained tier needs
 * no module CDN for the engine itself.
 */
export async function bundleBrowserRuntime(
  options: BundleBrowserRuntimeOptions = {},
): Promise<BundleResult> {
  const esbuild = await loadEsbuild();
  const entry = options.runtimeEntry ?? "@renderify/runtime";
  const resolveDir = options.resolveDir ?? process.cwd();

  const result = await esbuild.build({
    stdin: {
      contents: `export * from ${JSON.stringify(entry)};`,
      resolveDir,
      sourcefile: "renderify-shell-runtime-entry.js",
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName: "RenderifyRuntime",
    platform: "browser",
    target: "es2020",
    minify: options.minify !== false,
    write: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const code = result.outputFiles?.[0]?.text ?? "";
  if (code.length === 0) {
    throw new Error("bundleBrowserRuntime produced empty output");
  }
  return { code, bytes: Buffer.byteLength(code, "utf8") };
}

export interface BundleEsmModuleOptions {
  /** Entry specifier/path to bundle (e.g. "preact"). */
  entry?: string;
  /** Inline entry source instead of a file. */
  contents?: string;
  resolveDir?: string;
  minify?: boolean;
}

/**
 * Bundle a single browser-ESM module to a self-contained string. Useful for
 * serving dependencies (e.g. preact) from the host origin, or for small
 * `localModules` blob entries.
 */
export async function bundleEsmModule(
  options: BundleEsmModuleOptions,
): Promise<BundleResult> {
  const esbuild = await loadEsbuild();
  const resolveDir = options.resolveDir ?? process.cwd();
  const stdin = options.contents
    ? {
        contents: options.contents,
        resolveDir,
        sourcefile: "module.js",
        loader: "js" as const,
      }
    : {
        contents: `export * from ${JSON.stringify(options.entry)};\nexport { default } from ${JSON.stringify(options.entry)};`,
        resolveDir,
        sourcefile: "module.js",
        loader: "js" as const,
      };

  const result = await esbuild.build({
    stdin,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: options.minify !== false,
    write: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const code = result.outputFiles?.[0]?.text ?? "";
  if (code.length === 0) {
    throw new Error("bundleEsmModule produced empty output");
  }
  return { code, bytes: Buffer.byteLength(code, "utf8") };
}
