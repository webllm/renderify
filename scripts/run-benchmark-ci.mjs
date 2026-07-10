import { mkdir } from "node:fs/promises";

const outputDirectory = ".artifacts/benchmarks";
await mkdir(outputDirectory, { recursive: true });

process.env.RENDERIFY_BENCH_JSON = `${outputDirectory}/runtime-bench.json`;
process.env.RENDERIFY_BENCH_FORMAT = "github";

await import("../tests/bench/runtime.bench.ts");
