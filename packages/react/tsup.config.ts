import { defineConfig } from "tsup";

export default defineConfig({
  entry: { react: "src/index.ts" },
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
  external: [/^@renderify\//, "react", "react-dom"],
  // The components use effects and refs, so they are client components when
  // imported from React Server Components (for example the Next.js App Router).
  banner: { js: '"use client";' },
  outExtension({ format }) {
    return {
      js: format === "esm" ? ".mjs" : ".cjs",
    };
  },
});
