import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RuntimePlan } from "../packages/ir/src/index";
import {
  createMockEvalProvider,
  evaluateChecks,
  formatGenerationEvalMarkdown,
  GENERATION_CASES_PATH,
  type GenerationEvalCase,
  type GenerationEvalCaseResult,
  runGenerationEval,
  summarize,
} from "./evals/generation-eval";

async function loadDeclarativeCases(): Promise<GenerationEvalCase[]> {
  const cases = JSON.parse(
    await readFile(GENERATION_CASES_PATH, "utf8"),
  ) as GenerationEvalCase[];
  return cases.filter((evalCase) => evalCase.lane === "declarative");
}

test("generation eval cases are unique and cover both lanes", async () => {
  const cases = JSON.parse(
    await readFile(GENERATION_CASES_PATH, "utf8"),
  ) as GenerationEvalCase[];
  const ids = cases.map((evalCase) => evalCase.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(cases.some((evalCase) => evalCase.lane === "declarative"));
  assert.ok(cases.some((evalCase) => evalCase.lane === "source"));
  for (const evalCase of cases) {
    assert.ok(evalCase.prompt.trim().length > 0, evalCase.id);
  }
});

test("generation eval runs the real pipeline and counts repairs", async () => {
  const cases = await loadDeclarativeCases();
  const report = await runGenerationEval({
    providers: [
      createMockEvalProvider(cases, { repairProbeCaseId: "counter" }),
    ],
    cases,
    mode: "mock",
  });

  assert.equal(report.mode, "mock");
  const [provider] = report.providers;
  assert.equal(provider.provider, "mock");
  assert.equal(provider.summary.cases, cases.length);
  assert.equal(provider.summary.rendered, cases.length);
  assert.equal(provider.summary.checksPassed, cases.length);
  assert.equal(provider.summary.firstAttemptValid, cases.length - 1);

  const counter = provider.results.find(
    (result) => result.caseId === "counter",
  );
  assert.ok(counter);
  assert.equal(counter.firstAttemptValid, false);
  assert.equal(counter.attempts, 2);
  assert.equal(counter.status, "rendered");
});

test("generation eval checks explain why a plan misses the prompt", () => {
  const plan = {
    specVersion: "runtime-plan/v1",
    id: "checks",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "Only text" }],
    },
  } as RuntimePlan;

  assert.deepEqual(
    evaluateChecks(
      {
        id: "declarative",
        prompt: "p",
        lane: "declarative",
        checks: { tags: ["button"], minNodes: 5, minTransitions: 1 },
      },
      plan,
    ),
    [
      "missing <button>",
      "expected at least 5 nodes, got 2",
      "expected at least 1 transitions, got 0",
    ],
  );
  assert.deepEqual(
    evaluateChecks(
      {
        id: "source",
        prompt: "p",
        lane: "source",
        checks: { sourceIncludes: ["useState"] },
      },
      plan,
    ),
    ["expected a source module", 'source does not include "useState"'],
  );
});

test("generation eval summaries and markdown report outcomes", () => {
  const result = (
    overrides: Partial<GenerationEvalCaseResult>,
  ): GenerationEvalCaseResult => ({
    caseId: "case",
    lane: "declarative",
    status: "rendered",
    firstAttemptValid: true,
    attempts: 1,
    textFallback: false,
    checksPassed: true,
    failedChecks: [],
    latencyMs: 10,
    ...overrides,
  });
  const results = [
    result({ caseId: "a", latencyMs: 10, tokens: 5 }),
    result({
      caseId: "b",
      latencyMs: 30,
      attempts: 3,
      firstAttemptValid: false,
    }),
    result({
      caseId: "c",
      latencyMs: 20,
      status: "policy-rejected",
      checksPassed: false,
      error: "Security policy rejected runtime plan",
    }),
  ];
  const summary = summarize(results);
  assert.equal(summary.rendered, 2);
  assert.equal(summary.policyRejected, 1);
  assert.equal(summary.averageAttempts, 1.67);
  assert.equal(summary.p50LatencyMs, 20);
  assert.equal(summary.p95LatencyMs, 30);
  assert.equal(summary.tokens, 5);

  const markdown = formatGenerationEvalMarkdown({
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "live",
    providers: [{ provider: "openai", model: "gpt", results, summary }],
  });
  assert.match(
    markdown,
    /\| openai \| gpt \| 67% \| 67% \| 67% \| 1 \| 1\.67 \|/,
  );
  assert.match(markdown, /openai \/ c\*\*: policy-rejected/);
});
