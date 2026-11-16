/**
 * CLI for the generation eval. Live providers are configured with environment
 * variables (see docs/generation-evals.md); without any, it runs the
 * deterministic mock provider so the harness itself stays verified.
 *
 *   pnpm eval:generation            # live providers from RENDERIFY_EVAL_*
 *   pnpm eval:generation -- --mock  # deterministic fixtures, no network
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LLMInterpreter } from "../../packages/core/src/index";
import {
  AnthropicLLMInterpreter,
  GoogleLLMInterpreter,
  LMStudioLLMInterpreter,
  OllamaLLMInterpreter,
  OpenAICodexLLMInterpreter,
  OpenAILLMInterpreter,
} from "../../packages/llm/src/index";
import {
  createMockEvalProvider,
  formatGenerationEvalMarkdown,
  GENERATION_CASES_PATH,
  type GenerationEvalCase,
  type GenerationEvalProvider,
  runGenerationEval,
} from "./generation-eval";

type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "lmstudio"
  | "openai-codex";

const PROVIDER_FACTORIES: Record<
  ProviderName,
  (config: ProviderEnv) => LLMInterpreter
> = {
  openai: (config) =>
    new OpenAILLMInterpreter({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    }),
  anthropic: (config) =>
    new AnthropicLLMInterpreter({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    }),
  google: (config) =>
    new GoogleLLMInterpreter({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    }),
  ollama: (config) =>
    new OllamaLLMInterpreter({ model: config.model, baseUrl: config.baseUrl }),
  lmstudio: (config) =>
    new LMStudioLLMInterpreter({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    }),
  "openai-codex": (config) =>
    new OpenAICodexLLMInterpreter({
      accessToken: config.apiKey,
      accountId: config.accountId,
      model: config.model,
      baseUrl: config.baseUrl,
    }),
};

interface ProviderEnv {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  accountId?: string;
}

/** Reads RENDERIFY_EVAL_<PROVIDER>_<FIELD>, e.g. RENDERIFY_EVAL_OPENAI_API_KEY. */
function readProviderEnv(name: ProviderName): ProviderEnv {
  const prefix = `RENDERIFY_EVAL_${name.replaceAll("-", "_").toUpperCase()}_`;
  const read = (field: string) => {
    const value = process.env[`${prefix}${field}`]?.trim();
    return value ? value : undefined;
  };
  return {
    apiKey: read(name === "openai-codex" ? "ACCESS_TOKEN" : "API_KEY"),
    model: read("MODEL"),
    baseUrl: read("BASE_URL"),
    accountId: read("ACCOUNT_ID"),
  };
}

function resolveProviders(): GenerationEvalProvider[] {
  const requested = (process.env.RENDERIFY_EVAL_PROVIDERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const names = (
    requested.length > 0
      ? requested
      : (["openai", "anthropic", "google"] as const).filter(
          (name) => readProviderEnv(name).apiKey !== undefined,
        )
  ) as string[];

  return names.map((name) => {
    if (!Object.hasOwn(PROVIDER_FACTORIES, name)) {
      throw new Error(`Unknown eval provider: ${name}`);
    }
    const providerName = name as ProviderName;
    const config = readProviderEnv(providerName);
    return {
      name: providerName,
      ...(config.model ? { model: config.model } : {}),
      createInterpreter: () => PROVIDER_FACTORIES[providerName](config),
    };
  });
}

async function loadCases(): Promise<GenerationEvalCase[]> {
  const cases = JSON.parse(
    await readFile(GENERATION_CASES_PATH, "utf8"),
  ) as GenerationEvalCase[];
  const selected = (process.env.RENDERIFY_EVAL_CASES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return selected.length > 0
    ? cases.filter((evalCase) => selected.includes(evalCase.id))
    : cases;
}

async function main(): Promise<void> {
  const cases = await loadCases();
  const liveProviders = process.argv.includes("--mock")
    ? []
    : resolveProviders();
  const mode = liveProviders.length > 0 ? "live" : "mock";
  if (mode === "mock") {
    console.error(
      "No live providers configured (set RENDERIFY_EVAL_PROVIDERS and RENDERIFY_EVAL_<PROVIDER>_API_KEY); running deterministic mock fixtures.",
    );
  }
  const providers =
    mode === "live"
      ? liveProviders
      : [createMockEvalProvider(cases, { repairProbeCaseId: "counter" })];

  const report = await runGenerationEval({
    providers,
    cases,
    mode,
    onCaseComplete(provider, result) {
      console.error(
        `[eval] ${provider} ${result.caseId}: ${result.status}${
          result.failedChecks.length > 0
            ? ` (${result.failedChecks.join("; ")})`
            : ""
        } in ${result.latencyMs} ms`,
      );
    },
  });

  const markdown = formatGenerationEvalMarkdown(report);
  const outputDir = process.env.RENDERIFY_EVAL_OUTPUT_DIR ?? ".artifacts/evals";
  await mkdir(outputDir, { recursive: true });
  const stamp = report.generatedAt.replaceAll(":", "-");
  await writeFile(
    join(outputDir, `generation-${stamp}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(join(outputDir, `generation-${stamp}.md`), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  console.log(markdown);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
