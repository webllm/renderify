import type { RuntimeSecurityPolicy } from "./security";

export type SecurityProfileConfig = "strict" | "balanced" | "relaxed";
export type LLMProviderConfig = string;

const DEFAULT_RUNTIME_SPEC_VERSIONS = ["runtime-plan/v1"];
const DEFAULT_RUNTIME_REMOTE_FALLBACK_CDNS = ["https://esm.sh"];
const DEFAULT_JSPM_ALLOWED_NETWORK_HOSTS = ["ga.jspm.io", "cdn.jspm.io"];

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
  securityPolicy?: Partial<RuntimeSecurityPolicy>;
  runtimeJspmOnlyStrictMode: boolean;
  runtimeEnforceModuleManifest: boolean;
  runtimeAllowIsolationFallback: boolean;
  runtimeSupportedSpecVersions: string[];
  runtimeEnableDependencyPreflight: boolean;
  runtimeFailOnDependencyPreflightError: boolean;
  runtimeRemoteFetchTimeoutMs: number;
  runtimeRemoteFetchRetries: number;
  runtimeRemoteFetchBackoffMs: number;
  runtimeRemoteFallbackCdnBases: string[];
  runtimeBrowserSourceSandboxMode: "none" | "worker" | "iframe" | "shadowrealm";
  runtimeBrowserSourceSandboxTimeoutMs: number;
  runtimeBrowserSourceSandboxFailClosed: boolean;
  [key: string]: unknown;
}

export interface JspmOnlyStrictModeOptions {
  allowedNetworkHosts?: string[];
}

export function createJspmOnlyStrictModeConfig(
  options: JspmOnlyStrictModeOptions = {},
): Partial<RenderifyConfigValues> {
  const allowedNetworkHosts = normalizeJspmAllowedNetworkHosts(
    options.allowedNetworkHosts,
  );

  return {
    runtimeJspmOnlyStrictMode: true,
    strictSecurity: true,
    securityProfile: "strict",
    runtimeEnforceModuleManifest: true,
    runtimeAllowIsolationFallback: false,
    runtimeEnableDependencyPreflight: true,
    runtimeFailOnDependencyPreflightError: true,
    runtimeRemoteFallbackCdnBases: [],
    securityPolicy: {
      allowArbitraryNetwork: false,
      allowedNetworkHosts,
      requireModuleManifestForBareSpecifiers: true,
      requireModuleIntegrity: true,
      allowDynamicSourceImports: false,
    },
  };
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
      llmProvider: "openai",
      llmModel: "gpt-4.1-mini",
      llmBaseUrl: "https://api.openai.com/v1",
      llmRequestTimeoutMs: 30000,
      jspmCdnUrl: "https://ga.jspm.io/npm",
      strictSecurity: true,
      llmUseStructuredOutput: true,
      securityProfile: "balanced",
      runtimeJspmOnlyStrictMode: false,
      runtimeEnforceModuleManifest: true,
      runtimeAllowIsolationFallback: false,
      runtimeSupportedSpecVersions: [...DEFAULT_RUNTIME_SPEC_VERSIONS],
      runtimeEnableDependencyPreflight: true,
      runtimeFailOnDependencyPreflightError: false,
      runtimeRemoteFetchTimeoutMs: 12000,
      runtimeRemoteFetchRetries: 2,
      runtimeRemoteFetchBackoffMs: 150,
      runtimeRemoteFallbackCdnBases: [...DEFAULT_RUNTIME_REMOTE_FALLBACK_CDNS],
      runtimeBrowserSourceSandboxMode: "worker",
      runtimeBrowserSourceSandboxTimeoutMs: 4000,
      runtimeBrowserSourceSandboxFailClosed: true,
    };

    const merged = {
      ...defaultValues,
      ...env,
      ...(overrides ?? {}),
    } as RenderifyConfigValues;

    this.config = applyDerivedConfig(merged);
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

function applyDerivedConfig(
  input: RenderifyConfigValues,
): RenderifyConfigValues {
  if (input.runtimeJspmOnlyStrictMode !== true) {
    return input;
  }

  const existingPolicy = toSecurityPolicyOverrides(input.securityPolicy);
  const strictPreset = createJspmOnlyStrictModeConfig({
    allowedNetworkHosts: normalizeJspmAllowedNetworkHosts(
      existingPolicy.allowedNetworkHosts,
    ),
  });

  return {
    ...input,
    ...strictPreset,
    securityPolicy: {
      ...existingPolicy,
      ...toSecurityPolicyOverrides(strictPreset.securityPolicy),
    },
  };
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
    runtimeJspmOnlyStrictMode:
      process.env.RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE === "true",
    runtimeEnforceModuleManifest:
      process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST !== "false",
    runtimeAllowIsolationFallback:
      process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK === "true",
    runtimeSupportedSpecVersions: parseSpecVersions(
      process.env.RENDERIFY_RUNTIME_SPEC_VERSIONS,
    ),
    runtimeEnableDependencyPreflight:
      process.env.RENDERIFY_RUNTIME_PREFLIGHT !== "false",
    runtimeFailOnDependencyPreflightError:
      process.env.RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST === "true",
    runtimeRemoteFetchTimeoutMs:
      parsePositiveInt(process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS) ??
      12000,
    runtimeRemoteFetchRetries:
      parseNonNegativeInt(process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES) ??
      2,
    runtimeRemoteFetchBackoffMs:
      parseNonNegativeInt(
        process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_BACKOFF_MS,
      ) ?? 150,
    runtimeRemoteFallbackCdnBases: parseCsvValues(
      process.env.RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS,
      DEFAULT_RUNTIME_REMOTE_FALLBACK_CDNS,
    ),
    runtimeBrowserSourceSandboxMode: parseSourceSandboxMode(
      process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE,
    ),
    runtimeBrowserSourceSandboxFailClosed:
      process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED !== "false",
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

  const browserSandboxTimeout = parsePositiveInt(
    process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS,
  );
  if (browserSandboxTimeout !== undefined) {
    values.runtimeBrowserSourceSandboxTimeoutMs = browserSandboxTimeout;
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

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
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
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }

  return "openai";
}

function parseSpecVersions(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [...DEFAULT_RUNTIME_SPEC_VERSIONS];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : [...DEFAULT_RUNTIME_SPEC_VERSIONS];
}

function parseCsvValues(
  value: string | undefined,
  fallback: string[],
): string[] {
  if (!value || value.trim().length === 0) {
    return [...fallback];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : [...fallback];
}

function parseSourceSandboxMode(
  value: string | undefined,
): "none" | "worker" | "iframe" | "shadowrealm" {
  if (
    value === "none" ||
    value === "worker" ||
    value === "iframe" ||
    value === "shadowrealm"
  ) {
    return value;
  }

  return "worker";
}

function toSecurityPolicyOverrides(
  value: unknown,
): Partial<RuntimeSecurityPolicy> {
  if (!isRecord(value)) {
    return {};
  }

  return value as Partial<RuntimeSecurityPolicy>;
}

function normalizeJspmAllowedNetworkHosts(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : DEFAULT_JSPM_ALLOWED_NETWORK_HOSTS;
  const normalized: string[] = [];

  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }

    const host = normalizeNetworkHostEntry(entry);
    if (!host || !host.endsWith("jspm.io")) {
      continue;
    }

    if (!normalized.includes(host)) {
      normalized.push(host);
    }
  }

  return normalized.length > 0
    ? normalized
    : [...DEFAULT_JSPM_ALLOWED_NETWORK_HOSTS];
}

function normalizeNetworkHostEntry(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      return parsed.host;
    }
  } catch {
    // Fall through and treat as host text.
  }

  const hostLike = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/\/.*$/, "");

  return hostLike.length > 0 ? hostLike : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
