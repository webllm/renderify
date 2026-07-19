import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/index.ts",
    "playground-runtime-client": "src/playground-runtime-client.ts",
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
  platform: "node",
  external: [
    /^@renderify\//,
    "es-module-lexer",
    "preact",
    "preact-render-to-string",
  ],
  esbuildOptions(options, context) {
    options.define = {
      ...options.define,
      __RENDERIFY_CLI_DIR__:
        context.format === "esm" ? "import.meta.dirname" : "__dirname",
    };
  },
  outExtension({ format }) {
    return {
      js: format === "esm" ? ".mjs" : ".cjs",
    };
  },
});
