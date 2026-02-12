import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Bench } from "tinybench";
import { DefaultCodeGenerator } from "../../packages/core/src/codegen";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../../packages/ir/src/index";
import { DefaultRuntimeManager } from "../../packages/runtime/src/index";

interface BenchRow {
  name: string;
  hz: number;
  meanMs: number;
  rme: number;
  samples: number;
}

interface BenchReport {
  generatedAt: string;
  node: string;
  benchTimeMs: number;
  warmupTimeMs: number;
  tasks: BenchRow[];
}

const DEFAULT_BENCH_TIME_MS = 200;
const DEFAULT_WARMUP_TIME_MS = 100;

function parseDuration(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createPlan(): RuntimePlan {
  const metricsList = Array.from({ length: 12 }, (_, index) =>
    createElementNode("li", { "data-index": index }, [
      createTextNode(`Metric ${index + 1}`),
    ]),
  );

  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "bench-plan",
    version: 1,
    root: createElementNode("section", { class: "dashboard" }, [
      createElementNode("header", undefined, [
        createElementNode("h1", undefined, [createTextNode("Renderify Bench")]),
        createElementNode("p", undefined, [
          createTextNode("Runtime rendering throughput benchmark"),
        ]),
      ]),
      createElementNode("ul", { class: "metrics" }, metricsList),
    ]),
    capabilities: {
      domWrite: true,
      allowedModules: [],
      maxExecutionMs: 1500,
      maxComponentInvocations: 300,
    },
    state: {
      initial: {
        count: 0,
        status: "ready",
      },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  };
}

function createMarkdown(report: BenchReport): string {
  const header = [
    "### Runtime Benchmarks",
    "",
    `- Node: \`${report.node}\``,
    `- benchTimeMs: \`${report.benchTimeMs}\``,
    `- warmupTimeMs: \`${report.warmupTimeMs}\``,
    "",
    "| Task | ops/sec | mean (ms) | rme (%) | samples |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];

  const rows = report.tasks.map((task) =>
    [
      `| ${task.name}`,
      task.hz.toFixed(2),
      task.meanMs.toFixed(4),
      task.rme.toFixed(2),
      `${task.samples} |`,
    ].join(" | "),
  );

  return [...header, ...rows, ""].join("\n");
}

async function main(): Promise<void> {
  const benchTimeMs = parseDuration(
    process.env.RENDERIFY_BENCH_TIME_MS,
    DEFAULT_BENCH_TIME_MS,
  );
  const warmupTimeMs = parseDuration(
    process.env.RENDERIFY_BENCH_WARMUP_MS,
    DEFAULT_WARMUP_TIME_MS,
  );

  const codegen = new DefaultCodeGenerator();
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan = createPlan();
  const serializedPlan = JSON.stringify(plan);

  const bench = new Bench({
    name: "renderify-runtime",
    time: benchTimeMs,
    warmupTime: warmupTimeMs,
  });

  bench.add("codegen.generatePlan(json)", async () => {
    await codegen.generatePlan({
      prompt: "Build a runtime dashboard",
      llmText: serializedPlan,
    });
  });

  bench.add("runtime.executePlan(simple)", async () => {
    await runtime.executePlan(plan, {
      userId: "bench-user",
      variables: {
        locale: "en-US",
      },
    });
  });

  bench.add("runtime.compile(simple)", async () => {
    await runtime.compile(plan);
  });

  try {
    await bench.run();
  } finally {
    await runtime.terminate();
  }

  const tasks: BenchRow[] = bench.tasks.map((task) => {
    const result = task.result;
    if (
      result.state !== "completed" &&
      result.state !== "aborted-with-statistics"
    ) {
      return {
        name: task.name,
        hz: 0,
        meanMs: 0,
        rme: 0,
        samples: 0,
      };
    }

    const hz = result.throughput.mean;
    const meanMs = result.latency.mean;
    const rme = result.latency.rme;
    const samples = result.latency.samplesCount;

    return {
      name: task.name,
      hz,
      meanMs,
      rme,
      samples,
    };
  });

  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    benchTimeMs,
    warmupTimeMs,
    tasks,
  };

  const markdown = createMarkdown(report);
  console.log(markdown);

  const outputFile = process.env.RENDERIFY_BENCH_JSON;
  if (outputFile) {
    const outputPath = resolve(outputFile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (process.env.RENDERIFY_BENCH_FORMAT === "github") {
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummaryPath) {
      await appendFile(stepSummaryPath, `${markdown}\n`, "utf8");
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  console.error(message);
  process.exitCode = 1;
});
