export type SecurityProfileConfig = "strict" | "balanced" | "relaxed";
export type LLMProviderConfig = "mock" | "openai";

export interface TenantQuotaPolicyConfig {
  maxExecutionsPerMinute: number;
  maxConcurrentExecutions: number;
}

export interface RenderifyConfigValues {
  llmApiKey?: string;
  llmProvider: LLMProviderConfig;
  llmModel: string;
  llmBaseUrl: string;
  llmRequestTimeoutMs: number;
  llmUseStructuredOutput: boolean;
  jspmCdnUrl: string;
  strictSecurity: boolean;
  securityProfile: SecurityProfileConfig;
  tenantQuotaPolicy: TenantQuotaPolicyConfig;
  runtimeEnforceModuleManifest: boolean;
  runtimeAllowIsolationFallback: boolean;
  runtimeSupportedSpecVersions: string[];
  [key: string]: unknown;
}

export interface RenderifyConfig {
  load(overrides?: Partial<RenderifyConfigValues>): Promise<void>;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  snapshot(): Readonly<Record<string, unknown>>;
  save(): Promise<void>;
}

export class DefaultRenderifyConfig implements RenderifyConfig {
  private config: Record<string, unknown> = {};

  async load(overrides?: Partial<RenderifyConfigValues>) {
    const env = getEnvironmentValues();
    const defaultValues: RenderifyConfigValues = {
      llmProvider: "mock",
      llmModel: "gpt-4.1-mini",
      llmBaseUrl: "https://api.openai.com/v1",
      llmRequestTimeoutMs: 30000,
      jspmCdnUrl: "https://ga.jspm.io/npm",
      strictSecurity: true,
      llmUseStructuredOutput: true,
      securityProfile: "balanced",
      runtimeEnforceModuleManifest: true,
      runtimeAllowIsolationFallback: false,
      runtimeSupportedSpecVersions: ["runtime-plan/v1"],
      tenantQuotaPolicy: {
        maxExecutionsPerMinute: 120,
        maxConcurrentExecutions: 4,
      },
    };

    this.config = {
      ...defaultValues,
      ...env,
      ...(overrides ?? {}),
      tenantQuotaPolicy: {
        ...defaultValues.tenantQuotaPolicy,
        ...(env.tenantQuotaPolicy ?? {}),
        ...(overrides?.tenantQuotaPolicy ?? {}),
      },
    };
  }

  get<T = unknown>(key: string): T | undefined {
    return this.config[key] as T | undefined;
  }

  set(key: string, value: unknown) {
    this.config[key] = value;
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return { ...this.config };
  }

  async save() {
    // Persistence strategy is intentionally left to host applications.
  }
}

function getEnvironmentValues(): Partial<RenderifyConfigValues> {
  if (
    typeof process === "undefined" ||
    typeof process.env === "undefined" ||
    process.env === null
  ) {
    return {};
  }

  const values: Partial<RenderifyConfigValues> = {
    llmUseStructuredOutput:
      process.env.RENDERIFY_LLM_USE_STRUCTURED_OUTPUT !== "false",
    strictSecurity: process.env.RENDERIFY_STRICT_SECURITY !== "false",
    securityProfile: parseSecurityProfile(
      process.env.RENDERIFY_SECURITY_PROFILE,
    ),
    runtimeEnforceModuleManifest:
      process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST !== "false",
    runtimeAllowIsolationFallback:
      process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK === "true",
    runtimeSupportedSpecVersions: parseSpecVersions(
      process.env.RENDERIFY_RUNTIME_SPEC_VERSIONS,
    ),
    tenantQuotaPolicy: {
      maxExecutionsPerMinute:
        parsePositiveInt(process.env.RENDERIFY_MAX_EXECUTIONS_PER_MINUTE) ??
        120,
      maxConcurrentExecutions:
        parsePositiveInt(process.env.RENDERIFY_MAX_CONCURRENT_EXECUTIONS) ?? 4,
    },
  };

  if (process.env.RENDERIFY_LLM_API_KEY) {
    values.llmApiKey = process.env.RENDERIFY_LLM_API_KEY;
  }

  if (process.env.RENDERIFY_LLM_PROVIDER) {
    values.llmProvider = parseLlmProvider(process.env.RENDERIFY_LLM_PROVIDER);
  }

  if (process.env.RENDERIFY_LLM_MODEL) {
    values.llmModel = process.env.RENDERIFY_LLM_MODEL;
  }

  if (process.env.RENDERIFY_LLM_BASE_URL) {
    values.llmBaseUrl = process.env.RENDERIFY_LLM_BASE_URL;
  }

  const timeoutMs = parsePositiveInt(process.env.RENDERIFY_LLM_TIMEOUT_MS);
  if (timeoutMs !== undefined) {
    values.llmRequestTimeoutMs = timeoutMs;
  }

  if (process.env.RENDERIFY_JSPM_CDN_URL) {
    values.jspmCdnUrl = process.env.RENDERIFY_JSPM_CDN_URL;
  }

  return values;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseSecurityProfile(
  value: string | undefined,
): SecurityProfileConfig {
  if (value === "strict" || value === "balanced" || value === "relaxed") {
    return value;
  }

  return "balanced";
}

function parseLlmProvider(value: string | undefined): LLMProviderConfig {
  if (value === "openai" || value === "mock") {
    return value;
  }

  return "mock";
}

function parseSpecVersions(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return ["runtime-plan/v1"];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : ["runtime-plan/v1"];
}
