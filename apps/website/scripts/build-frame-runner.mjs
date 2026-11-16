import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

// The Playground preview runs @renderify/frame's runner, built from source so
// the website always matches the workspace packages it documents.
await build({
  absWorkingDir: repositoryRoot,
  alias: {
    "@renderify/ir": `${repositoryRoot}/packages/ir/src/index.ts`,
    "@renderify/runtime": `${repositoryRoot}/packages/runtime/src/index.ts`,
    "@renderify/security": `${repositoryRoot}/packages/security/src/index.ts`,
  },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: [`${repositoryRoot}/packages/frame/src/runner.ts`],
  external: ["node:*"],
  format: "iife",
  legalComments: "eof",
  minify: true,
  outfile: `${websiteRoot}/public/renderify-frame-runner.js`,
  platform: "browser",
  target: ["es2022"],
});
