import { existsSync } from "node:fs";
import path from "node:path";
import type { BuildOptions } from "esbuild";

declare const __RENDERIFY_CLI_DIR__: string;

export interface BundlePlaygroundRuntimeClientOptions {
  clientEntry?: string;
  resolveDir?: string;
  minify?: boolean;
  target?: BuildOptions["target"];
}

export async function bundlePlaygroundRuntimeClient(
  options: BundlePlaygroundRuntimeClientOptions = {},
): Promise<string> {
  const { build } = await import("esbuild");
  const clientEntry = options.clientEntry ?? resolveDefaultClientEntry();
  const resolveDir = path.resolve(options.resolveDir ?? process.cwd());
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(clientEntry)};`,
      resolveDir,
      sourcefile: "renderify-playground-runtime-entry.mjs",
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RenderifyPlaygroundRuntime",
    platform: "browser",
    target: options.target ?? ["es2022"],
    minify: options.minify ?? true,
    legalComments: "none",
    sourcemap: false,
    treeShaking: true,
    conditions: ["browser", "import", "default"],
    mainFields: ["browser", "module", "main"],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  const code = result.outputFiles?.[0]?.text;
  if (!code) {
    throw new Error("esbuild did not produce a Playground runtime bundle");
  }
  return code;
}

function resolveDefaultClientEntry(): string {
  const directory =
    typeof __RENDERIFY_CLI_DIR__ === "string"
      ? __RENDERIFY_CLI_DIR__
      : typeof __dirname === "string"
        ? __dirname
        : process.cwd();
  for (const filename of [
    "playground-runtime-client.mjs",
    "playground-runtime-client.cjs",
    "playground-runtime-client.ts",
  ]) {
    const candidate = path.join(directory, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Unable to locate the Renderify Playground runtime client; rebuild @renderify/cli",
  );
}
