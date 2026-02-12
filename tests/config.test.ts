import assert from "node:assert/strict";
import test from "node:test";
import { DefaultRenderifyConfig } from "../packages/core/src/config";

test("config loads default security profile and tenant quotas", async () => {
  const config = new DefaultRenderifyConfig();
  await config.load();

  assert.equal(config.get("securityProfile"), "balanced");
  assert.equal(config.get("llmProvider"), "mock");
  assert.equal(config.get("llmModel"), "gpt-4.1-mini");
  assert.equal(config.get("llmBaseUrl"), "https://api.openai.com/v1");
  assert.equal(config.get("llmRequestTimeoutMs"), 30000);
  assert.equal(config.get("runtimeEnforceModuleManifest"), true);
  assert.equal(config.get("runtimeAllowIsolationFallback"), false);
  assert.equal(config.get("runtimeEnableDependencyPreflight"), true);
  assert.equal(config.get("runtimeFailOnDependencyPreflightError"), false);
  assert.equal(config.get("runtimeRemoteFetchTimeoutMs"), 12000);
  assert.equal(config.get("runtimeRemoteFetchRetries"), 2);
  assert.equal(config.get("runtimeRemoteFetchBackoffMs"), 150);
  assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), [
    "https://esm.sh",
  ]);
  assert.deepEqual(config.get("runtimeSupportedSpecVersions"), [
    "runtime-plan/v1",
  ]);
  assert.deepEqual(config.get("tenantQuotaPolicy"), {
    maxExecutionsPerMinute: 120,
    maxConcurrentExecutions: 4,
  });
});

test("config reads security/tenant values from env", async () => {
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;
  const previousPerMinute = process.env.RENDERIFY_MAX_EXECUTIONS_PER_MINUTE;
  const previousConcurrent = process.env.RENDERIFY_MAX_CONCURRENT_EXECUTIONS;

  process.env.RENDERIFY_SECURITY_PROFILE = "strict";
  process.env.RENDERIFY_MAX_EXECUTIONS_PER_MINUTE = "30";
  process.env.RENDERIFY_MAX_CONCURRENT_EXECUTIONS = "2";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("securityProfile"), "strict");
    assert.deepEqual(config.get("tenantQuotaPolicy"), {
      maxExecutionsPerMinute: 30,
      maxConcurrentExecutions: 2,
    });
  } finally {
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
    restoreEnv("RENDERIFY_MAX_EXECUTIONS_PER_MINUTE", previousPerMinute);
    restoreEnv("RENDERIFY_MAX_CONCURRENT_EXECUTIONS", previousConcurrent);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

test("config reads llm provider values from env", async () => {
  const previousProvider = process.env.RENDERIFY_LLM_PROVIDER;
  const previousModel = process.env.RENDERIFY_LLM_MODEL;
  const previousBaseUrl = process.env.RENDERIFY_LLM_BASE_URL;
  const previousTimeout = process.env.RENDERIFY_LLM_TIMEOUT_MS;

  process.env.RENDERIFY_LLM_PROVIDER = "openai";
  process.env.RENDERIFY_LLM_MODEL = "gpt-5-mini";
  process.env.RENDERIFY_LLM_BASE_URL = "https://example.local/v1";
  process.env.RENDERIFY_LLM_TIMEOUT_MS = "12000";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("llmProvider"), "openai");
    assert.equal(config.get("llmModel"), "gpt-5-mini");
    assert.equal(config.get("llmBaseUrl"), "https://example.local/v1");
    assert.equal(config.get("llmRequestTimeoutMs"), 12000);
  } finally {
    restoreEnv("RENDERIFY_LLM_PROVIDER", previousProvider);
    restoreEnv("RENDERIFY_LLM_MODEL", previousModel);
    restoreEnv("RENDERIFY_LLM_BASE_URL", previousBaseUrl);
    restoreEnv("RENDERIFY_LLM_TIMEOUT_MS", previousTimeout);
  }
});

test("config reads runtime policy values from env", async () => {
  const previousEnforceManifest =
    process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST;
  const previousIsolationFallback =
    process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK;
  const previousSpecVersions = process.env.RENDERIFY_RUNTIME_SPEC_VERSIONS;
  const previousPreflight = process.env.RENDERIFY_RUNTIME_PREFLIGHT;
  const previousPreflightFailFast =
    process.env.RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST;
  const previousFetchTimeout =
    process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS;
  const previousFetchRetries =
    process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES;
  const previousFetchBackoff =
    process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_BACKOFF_MS;
  const previousFallbackCdns =
    process.env.RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS;

  process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST = "false";
  process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK = "true";
  process.env.RENDERIFY_RUNTIME_SPEC_VERSIONS =
    "runtime-plan/v1,runtime-plan/v2-draft";
  process.env.RENDERIFY_RUNTIME_PREFLIGHT = "false";
  process.env.RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST = "true";
  process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS = "9000";
  process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES = "4";
  process.env.RENDERIFY_RUNTIME_REMOTE_FETCH_BACKOFF_MS = "275";
  process.env.RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS =
    "https://esm.sh,https://cdn.jsdelivr.net";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("runtimeEnforceModuleManifest"), false);
    assert.equal(config.get("runtimeAllowIsolationFallback"), true);
    assert.equal(config.get("runtimeEnableDependencyPreflight"), false);
    assert.equal(config.get("runtimeFailOnDependencyPreflightError"), true);
    assert.equal(config.get("runtimeRemoteFetchTimeoutMs"), 9000);
    assert.equal(config.get("runtimeRemoteFetchRetries"), 4);
    assert.equal(config.get("runtimeRemoteFetchBackoffMs"), 275);
    assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), [
      "https://esm.sh",
      "https://cdn.jsdelivr.net",
    ]);
    assert.deepEqual(config.get("runtimeSupportedSpecVersions"), [
      "runtime-plan/v1",
      "runtime-plan/v2-draft",
    ]);
  } finally {
    restoreEnv("RENDERIFY_RUNTIME_ENFORCE_MANIFEST", previousEnforceManifest);
    restoreEnv(
      "RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK",
      previousIsolationFallback,
    );
    restoreEnv("RENDERIFY_RUNTIME_SPEC_VERSIONS", previousSpecVersions);
    restoreEnv("RENDERIFY_RUNTIME_PREFLIGHT", previousPreflight);
    restoreEnv(
      "RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST",
      previousPreflightFailFast,
    );
    restoreEnv(
      "RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS",
      previousFetchTimeout,
    );
    restoreEnv("RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES", previousFetchRetries);
    restoreEnv(
      "RENDERIFY_RUNTIME_REMOTE_FETCH_BACKOFF_MS",
      previousFetchBackoff,
    );
    restoreEnv("RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS", previousFallbackCdns);
  }
});
