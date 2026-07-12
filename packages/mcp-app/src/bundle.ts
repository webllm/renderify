import { existsSync } from "node:fs";
import path from "node:path";
import type { BuildOptions } from "esbuild";

declare const __RENDERIFY_MCP_APP_DIR__: string;

export interface BundleRenderifyMcpViewOptions {
  viewEntry?: string;
  resolveDir?: string;
  minify?: boolean;
  target?: BuildOptions["target"];
}

export interface RenderifyMcpViewBundle {
  code: string;
  bytes: number;
}

export async function bundleRenderifyMcpView(
  options: BundleRenderifyMcpViewOptions = {},
): Promise<RenderifyMcpViewBundle> {
  const { build } = await import("esbuild");
  const viewEntry = options.viewEntry ?? resolveDefaultViewEntry();
  const resolveDir = path.resolve(options.resolveDir ?? process.cwd());
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(viewEntry)};`,
      resolveDir,
      sourcefile: "renderify-mcp-view-entry.mjs",
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RenderifyMcpApp",
    platform: "browser",
    target: options.target ?? ["es2022"],
    minify: options.minify ?? true,
    legalComments: "none",
    sourcemap: false,
    treeShaking: true,
    supported: {
      "inline-script": false,
    },
    conditions: ["browser", "import", "default"],
    mainFields: ["browser", "module", "main"],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  const code = result.outputFiles?.[0]?.text;
  if (!code) {
    throw new Error("esbuild did not produce an MCP App view bundle");
  }
  if (/<\/script/i.test(code)) {
    throw new Error("MCP App view bundle contains an unsafe </script sequence");
  }

  return {
    code,
    bytes: new TextEncoder().encode(code).byteLength,
  };
}

function resolveDefaultViewEntry(): string {
  const directory =
    typeof __RENDERIFY_MCP_APP_DIR__ === "string"
      ? __RENDERIFY_MCP_APP_DIR__
      : typeof __dirname === "string"
        ? __dirname
        : process.cwd();
  for (const filename of ["view.mjs", "view.cjs", "view.ts"]) {
    const candidate = path.join(directory, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Unable to locate the @renderify/mcp-app browser view entry; rebuild the package or pass viewEntry",
  );
}
