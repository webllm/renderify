import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "mcp-app": "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      composite: false,
      baseUrl: ".",
      paths: {},
    },
  },
  clean: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  platform: "neutral",
  external: [/^@renderify\//, "esbuild"],
  outExtension({ format }) {
    return {
      js: format === "esm" ? ".esm.js" : ".cjs.js",
    };
  },
});
