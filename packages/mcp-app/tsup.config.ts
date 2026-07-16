import { defineConfig } from "tsup";
import packageMetadata from "./package.json";

export default defineConfig({
  entry: {
    "mcp-app": "src/index.ts",
    view: "src/view.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      composite: false,
      ignoreDeprecations: "6.0",
      paths: {},
    },
  },
  clean: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  platform: "neutral",
  external: [
    /^@modelcontextprotocol\//,
    /^@renderify\//,
    /^node:/,
    "esbuild",
    "preact",
    "preact-render-to-string",
    "zod",
    "zod/v4",
  ],
  esbuildOptions(options, context) {
    options.define = {
      ...options.define,
      __RENDERIFY_MCP_APP_DIR__:
        context.format === "esm" ? "import.meta.dirname" : "__dirname",
      __RENDERIFY_MCP_APP_VERSION__: JSON.stringify(packageMetadata.version),
    };
  },
  outExtension({ format }) {
    return {
      js: format === "esm" ? ".mjs" : ".cjs",
    };
  },
});
