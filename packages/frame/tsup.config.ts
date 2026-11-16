import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { defineConfig } from "tsup";
import packageMetadata from "./package.json";

export default defineConfig(async () => {
  rmSync("dist", { recursive: true, force: true });

  // The runner is the only code that executes inside the sandboxed iframe.
  // It bundles the runtime and Babel so the frame needs no import map.
  await build({
    entryPoints: ["src/runner.ts"],
    outfile: "dist/runner.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "eof",
    external: ["node:*"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const runnerIntegrity = `sha384-${createHash("sha384")
    .update(readFileSync("dist/runner.js"))
    .digest("base64")}`;

  return {
    entry: { frame: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: {
      compilerOptions: {
        composite: false,
        ignoreDeprecations: "6.0",
        paths: {},
      },
    },
    clean: false,
    sourcemap: true,
    target: "es2022",
    splitting: false,
    platform: "neutral",
    external: [/^@renderify\//],
    esbuildOptions(options) {
      options.define = {
        ...options.define,
        __RENDERIFY_FRAME_VERSION__: JSON.stringify(packageMetadata.version),
        __RENDERIFY_FRAME_RUNNER_INTEGRITY__: JSON.stringify(runnerIntegrity),
      };
    },
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".mjs" : ".cjs",
      };
    },
  };
});
