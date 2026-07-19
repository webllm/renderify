import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

await build({
  absWorkingDir: repositoryRoot,
  alias: {
    "@renderify/ir": `${repositoryRoot}/packages/ir/src/index.ts`,
    "@renderify/runtime": `${repositoryRoot}/packages/runtime/src/index.ts`,
    "@renderify/security": `${repositoryRoot}/packages/security/src/index.ts`,
  },
  bundle: true,
  entryPoints: [`${websiteRoot}/playground-runtime/runner.ts`],
  external: ["node:*"],
  format: "iife",
  legalComments: "none",
  minify: true,
  outfile: `${websiteRoot}/public/playground-runtime.js`,
  platform: "browser",
  target: ["es2022"],
});
