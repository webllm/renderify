/**
 * Generation evaluation harness: runs a prompt suite through the real
 * Renderify pipeline (LLM -> structured plan -> policy -> runtime render) for
 * each configured provider and reports how often models produce renderable,
 * policy-compliant UI on the first try.
 */
import {
  type LLMInterpreter,
  type LLMRequest,
  type LLMResponse,
  type LLMResponseStreamChunk,
  type LLMStructuredRequest,
  type LLMStructuredResponse,
  PolicyRejectionError,
  RenderifyApp,
  StructuredPlanGenerationError,
} from "../../packages/core/src/index";
import type { RuntimeNode, RuntimePlan } from "../../packages/ir/src/index";
import { createRenderify } from "../../packages/renderify/src/index";

/** Prompt suite location, relative to the repository root. */
export const GENERATION_CASES_PATH = "tests/evals/generation-cases.json";

export type GenerationEvalLane = "declarative" | "source";

export interface GenerationEvalChecks {
  /** HTML tags that must appear in the plan tree (or as JSX in source). */
  tags?: string[];
  /** Minimum number of nodes in a declarative plan tree. */
  minNodes?: number;
  /** Minimum number of declarative state transitions. */
  minTransitions?: number;
  /** Substrings that must appear in the source module. */
  sourceIncludes?: string[];
}

export interface GenerationEvalCase {
  id: string;
  prompt: string;
  lane: GenerationEvalLane;
  checks?: GenerationEvalChecks;
}

export type GenerationEvalStatus =
  | "rendered"
  | "invalid-plan"
  | "policy-rejected"
  | "render-error"
  | "provider-error";

export interface GenerationEvalCaseResult {
  caseId: string;
  lane: GenerationEvalLane;
  status: GenerationEvalStatus;
  /** The first model call returned a valid structured RuntimePlan. */
  firstAttemptValid: boolean;
  /** Model calls made for this case, including repairs and text fallback. */
  attempts: number;
  textFallback: boolean;
  checksPassed: boolean;
  failedChecks: string[];
  latencyMs: number;
  tokens?: number;
  planId?: string;
  error?: string;
}

export interface GenerationEvalSummary {
  cases: number;
  rendered: number;
  firstAttemptValid: number;
  checksPassed: number;
  policyRejected: number;
  invalidPlans: number;
  errors: number;
  averageAttempts: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  tokens: number;
}

export interface GenerationEvalProviderReport {
  provider: string;
  model?: string;
  results: GenerationEvalCaseResult[];
  summary: GenerationEvalSummary;
}

export interface GenerationEvalReport {
  generatedAt: string;
  mode: "live" | "mock";
  providers: GenerationEvalProviderReport[];
}

export interface GenerationEvalProvider {
  name: string;
  model?: string;
  createInterpreter(): LLMInterpreter;
}

export interface RunGenerationEvalOptions {
  providers: GenerationEvalProvider[];
  cases: GenerationEvalCase[];
  mode?: GenerationEvalReport["mode"];
  /** Abort a single case after this long. @defaultValue 120000 */
  caseTimeoutMs?: number;
  onCaseComplete?: (provider: string, result: GenerationEvalCaseResult) => void;
}

interface AttemptRecord {
  kind: "structured" | "text" | "stream";
  valid?: boolean;
  tokens?: number;
}

/** Delegates to a provider while recording every model call. */
class InstrumentedInterpreter implements LLMInterpreter {
  readonly attempts: AttemptRecord[] = [];

  constructor(private readonly inner: LLMInterpreter) {}

  configure(options: Record<string, unknown>): void {
    this.inner.configure(options);
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.generateResponse(req);
    this.attempts.push({ kind: "text", tokens: response.tokensUsed });
    return response;
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    if (!this.inner.generateResponseStream) {
      const response = await this.generateResponse(req);
      yield {
        delta: response.text,
        text: response.text,
        done: true,
        index: 0,
        tokensUsed: response.tokensUsed,
        model: response.model,
      };
      return;
    }
    this.attempts.push({ kind: "stream" });
    yield* this.inner.generateResponseStream(req);
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    if (!this.inner.generateStructuredResponse) {
      throw new Error("Provider does not support structured responses");
    }
    const response = await this.inner.generateStructuredResponse<T>(req);
    this.attempts.push({
      kind: "structured",
      valid: response.valid,
      tokens: response.tokensUsed,
    });
    return response;
  }

  setPromptTemplate(templateName: string, templateContent: string): void {
    this.inner.setPromptTemplate(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.inner.getPromptTemplate(templateName);
  }
}

export async function runGenerationEval(
  options: RunGenerationEvalOptions,
): Promise<GenerationEvalReport> {
  const providers: GenerationEvalProviderReport[] = [];
  for (const provider of options.providers) {
    const results: GenerationEvalCaseResult[] = [];
    for (const evalCase of options.cases) {
      const result = await runCase(
        provider,
        evalCase,
        options.caseTimeoutMs ?? 120_000,
      );
      results.push(result);
      options.onCaseComplete?.(provider.name, result);
    }
    providers.push({
      provider: provider.name,
      ...(provider.model ? { model: provider.model } : {}),
      results,
      summary: summarize(results),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode ?? "live",
    providers,
  };
}

async function runCase(
  provider: GenerationEvalProvider,
  evalCase: GenerationEvalCase,
  timeoutMs: number,
): Promise<GenerationEvalCaseResult> {
  const interpreter = new InstrumentedInterpreter(provider.createInterpreter());
  const { dependencies } = createRenderify({ llm: interpreter });
  const app = new RenderifyApp({
    ...dependencies,
    configLoadOverrides: {
      securityProfile: evalCase.lane === "source" ? "trusted" : "balanced",
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  let status: GenerationEvalStatus = "rendered";
  let plan: RuntimePlan | undefined;
  let error: string | undefined;
  try {
    await app.start();
    const rendered = await app.renderPrompt(evalCase.prompt, {
      signal: controller.signal,
    });
    plan = rendered.plan;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    status =
      caught instanceof StructuredPlanGenerationError
        ? "invalid-plan"
        : caught instanceof PolicyRejectionError
          ? "policy-rejected"
          : interpreter.attempts.length === 0
            ? "provider-error"
            : "render-error";
  } finally {
    clearTimeout(timer);
    await app.stop().catch(() => undefined);
  }

  const failedChecks =
    status === "rendered" && plan ? evaluateChecks(evalCase, plan) : [];
  const tokens = interpreter.attempts.reduce(
    (total, attempt) => total + (attempt.tokens ?? 0),
    0,
  );
  const first = interpreter.attempts[0];
  return {
    caseId: evalCase.id,
    lane: evalCase.lane,
    status,
    firstAttemptValid: first?.kind === "structured" && first.valid === true,
    attempts: interpreter.attempts.length,
    textFallback: interpreter.attempts.some(
      (attempt) => attempt.kind !== "structured",
    ),
    checksPassed: status === "rendered" && failedChecks.length === 0,
    failedChecks,
    latencyMs: Math.round(performance.now() - startedAt),
    ...(tokens > 0 ? { tokens } : {}),
    ...(plan ? { planId: plan.id } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}

/** Structural checks that a rendered plan actually answers the prompt. */
export function evaluateChecks(
  evalCase: GenerationEvalCase,
  plan: RuntimePlan,
): string[] {
  const failures: string[] = [];
  const checks = evalCase.checks ?? {};
  const source = plan.source?.code;

  if (evalCase.lane === "source" && !source) {
    failures.push("expected a source module");
  }
  if (evalCase.lane === "declarative" && source) {
    failures.push("expected a declarative plan without source");
  }

  const tags = collectTags(plan.root);
  for (const tag of checks.tags ?? []) {
    const inSource =
      source !== undefined && new RegExp(`<${tag}[\\s>/]`, "i").test(source);
    if (!tags.has(tag.toLowerCase()) && !inSource) {
      failures.push(`missing <${tag}>`);
    }
  }
  if (checks.minNodes !== undefined) {
    const nodes = countNodes(plan.root);
    if (nodes < checks.minNodes) {
      failures.push(`expected at least ${checks.minNodes} nodes, got ${nodes}`);
    }
  }
  if (checks.minTransitions !== undefined) {
    const transitions = Object.keys(plan.state?.transitions ?? {}).length;
    if (transitions < checks.minTransitions) {
      failures.push(
        `expected at least ${checks.minTransitions} transitions, got ${transitions}`,
      );
    }
  }
  for (const fragment of checks.sourceIncludes ?? []) {
    if (!source?.includes(fragment)) {
      failures.push(`source does not include ${JSON.stringify(fragment)}`);
    }
  }
  return failures;
}

function collectTags(node: RuntimeNode, tags = new Set<string>()): Set<string> {
  if (node.type === "element") {
    tags.add(node.tag.toLowerCase());
  }
  if (node.type !== "text") {
    for (const child of node.children ?? []) {
      collectTags(child, tags);
    }
  }
  return tags;
}

function countNodes(node: RuntimeNode): number {
  if (node.type === "text") {
    return 1;
  }
  return (
    1 +
    (node.children ?? []).reduce((total, child) => total + countNodes(child), 0)
  );
}

export function summarize(
  results: GenerationEvalCaseResult[],
): GenerationEvalSummary {
  const latencies = results
    .map((result) => result.latencyMs)
    .sort((left, right) => left - right);
  const count = (predicate: (result: GenerationEvalCaseResult) => boolean) =>
    results.filter(predicate).length;
  return {
    cases: results.length,
    rendered: count((result) => result.status === "rendered"),
    firstAttemptValid: count((result) => result.firstAttemptValid),
    checksPassed: count((result) => result.checksPassed),
    policyRejected: count((result) => result.status === "policy-rejected"),
    invalidPlans: count((result) => result.status === "invalid-plan"),
    errors: count(
      (result) =>
        result.status === "render-error" || result.status === "provider-error",
    ),
    averageAttempts:
      results.length === 0
        ? 0
        : Math.round(
            (results.reduce((total, result) => total + result.attempts, 0) /
              results.length) *
              100,
          ) / 100,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    tokens: results.reduce((total, result) => total + (result.tokens ?? 0), 0),
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

export function formatGenerationEvalMarkdown(
  report: GenerationEvalReport,
): string {
  const percent = (value: number, total: number) =>
    total === 0 ? "-" : `${Math.round((value / total) * 100)}%`;
  const lines = [
    `## Renderify generation eval (${report.mode})`,
    "",
    `Generated ${report.generatedAt}.`,
    "",
    "| Provider | Model | Rendered | Valid on first try | Checks passed | Policy rejections | Avg. model calls | p50 latency | p95 latency | Tokens |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { provider, model, summary } of report.providers) {
    lines.push(
      `| ${provider} | ${model ?? "-"} | ${percent(summary.rendered, summary.cases)} | ${percent(summary.firstAttemptValid, summary.cases)} | ${percent(summary.checksPassed, summary.cases)} | ${summary.policyRejected} | ${summary.averageAttempts} | ${summary.p50LatencyMs} ms | ${summary.p95LatencyMs} ms | ${summary.tokens || "-"} |`,
    );
  }

  const failures = report.providers.flatMap(({ provider, results }) =>
    results
      .filter((result) => !result.checksPassed)
      .map(
        (result) =>
          `- **${provider} / ${result.caseId}**: ${result.status}${
            result.failedChecks.length > 0
              ? ` (${result.failedChecks.join("; ")})`
              : ""
          }${result.error ? ` — ${result.error.slice(0, 160)}` : ""}`,
      ),
  );
  if (failures.length > 0) {
    lines.push("", "### Cases needing attention", "", ...failures);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A deterministic provider for CI smoke runs and harness tests. It answers each
 * case with a canned plan that satisfies the case checks, and deliberately
 * returns one malformed structured payload first for `repairProbeCaseId` so the
 * repair path is exercised.
 */
export function createMockEvalProvider(
  cases: GenerationEvalCase[],
  options: { repairProbeCaseId?: string } = {},
): GenerationEvalProvider {
  const byPrompt = new Map(
    cases.map((evalCase) => [evalCase.prompt, evalCase]),
  );
  return {
    name: "mock",
    model: "deterministic-fixtures",
    createInterpreter() {
      let structuredCalls = 0;
      const findCase = (prompt: string) => {
        for (const [casePrompt, evalCase] of byPrompt) {
          if (prompt.includes(casePrompt)) {
            return evalCase;
          }
        }
        return undefined;
      };
      return {
        configure() {},
        async generateResponse(req) {
          const evalCase = findCase(req.prompt);
          return {
            text: JSON.stringify(evalCase ? mockPlanFor(evalCase) : {}),
            tokensUsed: 0,
            model: "deterministic-fixtures",
          };
        },
        async generateStructuredResponse<T>(req: LLMStructuredRequest) {
          structuredCalls += 1;
          const evalCase = findCase(req.prompt);
          if (
            evalCase &&
            evalCase.id === options.repairProbeCaseId &&
            structuredCalls === 1
          ) {
            return {
              text: "{}",
              value: {} as T,
              valid: false,
              errors: ["Structured payload is not a valid RuntimePlan"],
              tokensUsed: 0,
            };
          }
          const plan = evalCase ? mockPlanFor(evalCase) : undefined;
          return {
            text: JSON.stringify(plan ?? {}),
            value: (plan ?? {}) as T,
            valid: plan !== undefined,
            ...(plan
              ? {}
              : { errors: ["Mock provider has no fixture for this prompt"] }),
            tokensUsed: 0,
          };
        },
        setPromptTemplate() {},
        getPromptTemplate() {
          return undefined;
        },
      };
    },
  };
}

function mockPlanFor(evalCase: GenerationEvalCase): RuntimePlan {
  const checks = evalCase.checks ?? {};
  const base = {
    specVersion: "runtime-plan/v1",
    id: `mock_${evalCase.id.replace(/[^a-z0-9]+/gi, "_")}`,
    version: 1,
    capabilities: { domWrite: true },
  };
  if (evalCase.lane === "source") {
    const body = (checks.tags ?? ["button"])
      .map((tag) => `<${tag}>${tag}</${tag}>`)
      .join("");
    const includes = (checks.sourceIncludes ?? []).join(" ");
    return {
      ...base,
      root: { type: "text", value: "Loading..." },
      source: {
        language: "jsx",
        runtime: "preact",
        code: `import { useState } from "preact/hooks";\n// ${includes}\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main onClick={() => setCount(count + 1)}>${body}{count}</main>;\n}\n`,
      },
    } as RuntimePlan;
  }

  const transitions: Record<string, unknown> = {};
  const buttons: RuntimeNode[] = [];
  for (let index = 0; index < (checks.minTransitions ?? 0); index += 1) {
    transitions[`action${index}`] = [
      { type: "increment", path: "count", by: 1 },
    ];
    buttons.push({
      type: "element",
      tag: "button",
      props: { onClick: `action${index}` },
      children: [{ type: "text", value: `Action ${index}` }],
    });
  }
  const children: RuntimeNode[] = (checks.tags ?? []).map((tag) => ({
    type: "element",
    tag,
    children: [{ type: "text", value: tag }],
  }));
  children.push(...buttons);
  while (children.length + 1 < (checks.minNodes ?? 0)) {
    children.push({ type: "text", value: "Item" });
  }
  return {
    ...base,
    root: { type: "element", tag: "section", children },
    state: {
      initial: { count: 0 },
      transitions: transitions as NonNullable<
        RuntimePlan["state"]
      >["transitions"],
    },
  } as RuntimePlan;
}
