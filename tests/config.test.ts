import assert from "node:assert/strict";
import test from "node:test";
import { DefaultRenderifyConfig } from "../packages/config/src/index";

test("config loads default security profile and tenant quotas", async () => {
  const config = new DefaultRenderifyConfig();
  await config.load();

  assert.equal(config.get("securityProfile"), "balanced");
  assert.equal(config.get("llmProvider"), "mock");
  assert.equal(config.get("llmModel"), "gpt-4.1-mini");
  assert.equal(config.get("llmBaseUrl"), "https://api.openai.com/v1");
  assert.equal(config.get("llmRequestTimeoutMs"), 30000);
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
