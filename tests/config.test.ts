import assert from "node:assert/strict";
import test from "node:test";
import {
  createJspmOnlyStrictModeConfig,
  DefaultRenderifyConfig,
} from "../packages/core/src/config";

test("config loads default security profile and runtime defaults", async () => {
  const config = new DefaultRenderifyConfig();
  await config.load();

  assert.equal(config.get("securityProfile"), "balanced");
  assert.equal(config.get("llmProvider"), "openai");
  assert.equal(config.get("llmModel"), "gpt-5-mini");
  assert.equal(config.get("llmBaseUrl"), "https://api.openai.com/v1");
  assert.equal(config.get("llmRequestTimeoutMs"), 30000);
  assert.equal(config.get("llmMaxRetries"), 2);
  assert.equal(config.get("llmStructuredRetryOnInvalid"), true);
  assert.equal(config.get("llmStructuredFallbackToText"), true);
  assert.equal(config.get("runtimeJspmOnlyStrictMode"), false);
  assert.equal(config.get("runtimeEnforceModuleManifest"), true);
  assert.equal(config.get("runtimeAllowIsolationFallback"), false);
  assert.equal(config.get("runtimeEnableDependencyPreflight"), true);
  assert.equal(config.get("runtimeFailOnDependencyPreflightError"), false);
  assert.equal(config.get("runtimeAutoPinLatestModuleManifest"), true);
  assert.equal(config.get("runtimeAutoPinFetchTimeoutMs"), 4000);
  assert.equal(config.get("runtimeRemoteFetchTimeoutMs"), 12000);
  assert.equal(config.get("runtimeRemoteFetchRetries"), 2);
  assert.equal(config.get("runtimeRemoteFetchBackoffMs"), 150);
  assert.equal(config.get("runtimeBrowserSourceSandboxMode"), "worker");
  assert.equal(config.get("runtimeBrowserSourceSandboxTimeoutMs"), 4000);
  assert.equal(config.get("runtimeBrowserSourceSandboxFailClosed"), true);
  assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), [
    "https://esm.sh",
  ]);
  assert.deepEqual(config.get("runtimeSupportedSpecVersions"), [
    "runtime-plan/v1",
  ]);
});

test("config reads security profile from env", async () => {
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;

  process.env.RENDERIFY_SECURITY_PROFILE = "strict";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("securityProfile"), "strict");
  } finally {
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
  }
});

test("config accepts trusted security profile from env", async () => {
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;

  process.env.RENDERIFY_SECURITY_PROFILE = "trusted";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("securityProfile"), "trusted");
  } finally {
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
  }
});

test("config maps explicit strictSecurity=false to relaxed profile when profile is unset", async () => {
  const previousStrictSecurity = process.env.RENDERIFY_STRICT_SECURITY;
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;

  process.env.RENDERIFY_STRICT_SECURITY = "false";
  delete process.env.RENDERIFY_SECURITY_PROFILE;

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("securityProfile"), "relaxed");
  } finally {
    restoreEnv("RENDERIFY_STRICT_SECURITY", previousStrictSecurity);
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
  }
});

test("config lets explicit securityProfile override strictSecurity alias", async () => {
  const previousStrictSecurity = process.env.RENDERIFY_STRICT_SECURITY;
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;

  process.env.RENDERIFY_STRICT_SECURITY = "false";
  process.env.RENDERIFY_SECURITY_PROFILE = "strict";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("securityProfile"), "strict");
  } finally {
    restoreEnv("RENDERIFY_STRICT_SECURITY", previousStrictSecurity);
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
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
  const previousMaxRetries = process.env.RENDERIFY_LLM_MAX_RETRIES;
  const previousStructuredRetry = process.env.RENDERIFY_LLM_STRUCTURED_RETRY;
  const previousStructuredFallback =
    process.env.RENDERIFY_LLM_STRUCTURED_FALLBACK_TEXT;

  process.env.RENDERIFY_LLM_PROVIDER = "openai";
  process.env.RENDERIFY_LLM_MODEL = "gpt-5-mini";
  process.env.RENDERIFY_LLM_BASE_URL = "https://example.local/v1";
  process.env.RENDERIFY_LLM_TIMEOUT_MS = "12000";
  process.env.RENDERIFY_LLM_MAX_RETRIES = "0";
  process.env.RENDERIFY_LLM_STRUCTURED_RETRY = "false";
  process.env.RENDERIFY_LLM_STRUCTURED_FALLBACK_TEXT = "false";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("llmProvider"), "openai");
    assert.equal(config.get("llmModel"), "gpt-5-mini");
    assert.equal(config.get("llmBaseUrl"), "https://example.local/v1");
    assert.equal(config.get("llmRequestTimeoutMs"), 12000);
    assert.equal(config.get("llmMaxRetries"), 0);
    assert.equal(config.get("llmStructuredRetryOnInvalid"), false);
    assert.equal(config.get("llmStructuredFallbackToText"), false);
  } finally {
    restoreEnv("RENDERIFY_LLM_PROVIDER", previousProvider);
    restoreEnv("RENDERIFY_LLM_MODEL", previousModel);
    restoreEnv("RENDERIFY_LLM_BASE_URL", previousBaseUrl);
    restoreEnv("RENDERIFY_LLM_TIMEOUT_MS", previousTimeout);
    restoreEnv("RENDERIFY_LLM_MAX_RETRIES", previousMaxRetries);
    restoreEnv("RENDERIFY_LLM_STRUCTURED_RETRY", previousStructuredRetry);
    restoreEnv(
      "RENDERIFY_LLM_STRUCTURED_FALLBACK_TEXT",
      previousStructuredFallback,
    );
  }
});

test("config derives google defaults when only provider is configured", async () => {
  const previousProvider = process.env.RENDERIFY_LLM_PROVIDER;
  const previousModel = process.env.RENDERIFY_LLM_MODEL;
  const previousBaseUrl = process.env.RENDERIFY_LLM_BASE_URL;

  process.env.RENDERIFY_LLM_PROVIDER = "google";
  delete process.env.RENDERIFY_LLM_MODEL;
  delete process.env.RENDERIFY_LLM_BASE_URL;

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("llmProvider"), "google");
    assert.equal(config.get("llmModel"), "gemini-2.5-flash");
    assert.equal(
      config.get("llmBaseUrl"),
      "https://generativelanguage.googleapis.com/v1beta",
    );
  } finally {
    restoreEnv("RENDERIFY_LLM_PROVIDER", previousProvider);
    restoreEnv("RENDERIFY_LLM_MODEL", previousModel);
    restoreEnv("RENDERIFY_LLM_BASE_URL", previousBaseUrl);
  }
});

test("config derives openai codex defaults when only provider is configured", async () => {
  const previousProvider = process.env.RENDERIFY_LLM_PROVIDER;
  const previousModel = process.env.RENDERIFY_LLM_MODEL;
  const previousBaseUrl = process.env.RENDERIFY_LLM_BASE_URL;
  const previousTimeout = process.env.RENDERIFY_LLM_TIMEOUT_MS;

  process.env.RENDERIFY_LLM_PROVIDER = "openai-codex";
  delete process.env.RENDERIFY_LLM_MODEL;
  delete process.env.RENDERIFY_LLM_BASE_URL;
  delete process.env.RENDERIFY_LLM_TIMEOUT_MS;

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("llmProvider"), "openai-codex");
    assert.equal(config.get("llmModel"), "gpt-5.5");
    assert.equal(
      config.get("llmBaseUrl"),
      "https://chatgpt.com/backend-api/codex",
    );
    assert.equal(config.get("llmRequestTimeoutMs"), 300000);
  } finally {
    restoreEnv("RENDERIFY_LLM_PROVIDER", previousProvider);
    restoreEnv("RENDERIFY_LLM_MODEL", previousModel);
    restoreEnv("RENDERIFY_LLM_BASE_URL", previousBaseUrl);
    restoreEnv("RENDERIFY_LLM_TIMEOUT_MS", previousTimeout);
  }
});

test("config derives local-provider defaults when only provider is configured", async (t) => {
  const previousProvider = process.env.RENDERIFY_LLM_PROVIDER;
  const previousModel = process.env.RENDERIFY_LLM_MODEL;
  const previousBaseUrl = process.env.RENDERIFY_LLM_BASE_URL;
  delete process.env.RENDERIFY_LLM_PROVIDER;
  delete process.env.RENDERIFY_LLM_MODEL;
  delete process.env.RENDERIFY_LLM_BASE_URL;

  try {
    const cases = [
      {
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
      {
        provider: "lmstudio",
        model: "qwen2.5-coder-7b-instruct",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ] as const;

    for (const entry of cases) {
      await t.test(entry.provider, async () => {
        const config = new DefaultRenderifyConfig();
        await config.load({ llmProvider: entry.provider });

        assert.equal(config.get("llmModel"), entry.model);
        assert.equal(config.get("llmBaseUrl"), entry.baseUrl);
      });
    }
  } finally {
    restoreEnv("RENDERIFY_LLM_PROVIDER", previousProvider);
    restoreEnv("RENDERIFY_LLM_MODEL", previousModel);
    restoreEnv("RENDERIFY_LLM_BASE_URL", previousBaseUrl);
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
  const previousBrowserSandboxMode =
    process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE;
  const previousBrowserSandboxTimeout =
    process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS;
  const previousBrowserSandboxFailClosed =
    process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED;

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
  process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE = "iframe";
  process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS = "6200";
  process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED = "false";

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
    assert.equal(config.get("runtimeBrowserSourceSandboxMode"), "iframe");
    assert.equal(config.get("runtimeBrowserSourceSandboxTimeoutMs"), 6200);
    assert.equal(config.get("runtimeBrowserSourceSandboxFailClosed"), false);
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
    restoreEnv(
      "RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE",
      previousBrowserSandboxMode,
    );
    restoreEnv(
      "RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS",
      previousBrowserSandboxTimeout,
    );
    restoreEnv(
      "RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED",
      previousBrowserSandboxFailClosed,
    );
  }
});

test("config reads shadowrealm browser sandbox mode from env", async () => {
  const previousBrowserSandboxMode =
    process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE;

  process.env.RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE = "shadowrealm";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("runtimeBrowserSourceSandboxMode"), "shadowrealm");
  } finally {
    restoreEnv(
      "RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE",
      previousBrowserSandboxMode,
    );
  }
});

test("config applies jspm-only strict mode from env", async () => {
  const previousMode = process.env.RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE;
  const previousProfile = process.env.RENDERIFY_SECURITY_PROFILE;
  const previousEnforceManifest =
    process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST;
  const previousIsolationFallback =
    process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK;
  const previousPreflight = process.env.RENDERIFY_RUNTIME_PREFLIGHT;
  const previousPreflightFailFast =
    process.env.RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST;
  const previousFallbackCdns =
    process.env.RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS;

  process.env.RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE = "true";
  process.env.RENDERIFY_SECURITY_PROFILE = "relaxed";
  process.env.RENDERIFY_RUNTIME_ENFORCE_MANIFEST = "false";
  process.env.RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK = "true";
  process.env.RENDERIFY_RUNTIME_PREFLIGHT = "false";
  process.env.RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST = "false";
  process.env.RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS =
    "https://esm.sh,https://cdn.jsdelivr.net";

  try {
    const config = new DefaultRenderifyConfig();
    await config.load();

    assert.equal(config.get("runtimeJspmOnlyStrictMode"), true);
    assert.equal(config.get("securityProfile"), "strict");
    assert.equal(config.get("runtimeEnforceModuleManifest"), true);
    assert.equal(config.get("runtimeAllowIsolationFallback"), false);
    assert.equal(config.get("runtimeEnableDependencyPreflight"), true);
    assert.equal(config.get("runtimeFailOnDependencyPreflightError"), true);
    assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), []);

    assert.deepEqual(config.get("securityPolicy"), {
      allowArbitraryNetwork: false,
      allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
      requireModuleManifestForBareSpecifiers: true,
      requireModuleIntegrity: true,
      allowDynamicSourceImports: false,
    });
  } finally {
    restoreEnv("RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE", previousMode);
    restoreEnv("RENDERIFY_SECURITY_PROFILE", previousProfile);
    restoreEnv("RENDERIFY_RUNTIME_ENFORCE_MANIFEST", previousEnforceManifest);
    restoreEnv(
      "RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK",
      previousIsolationFallback,
    );
    restoreEnv("RENDERIFY_RUNTIME_PREFLIGHT", previousPreflight);
    restoreEnv(
      "RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST",
      previousPreflightFailFast,
    );
    restoreEnv("RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS", previousFallbackCdns);
  }
});

test("config applies jspm-only strict mode preset programmatically", async () => {
  const config = new DefaultRenderifyConfig();
  await config.load(
    createJspmOnlyStrictModeConfig({
      allowedNetworkHosts: [
        "https://ga.jspm.io",
        "cdn.jspm.io",
        "evil.example.com",
      ],
    }),
  );

  assert.equal(config.get("runtimeJspmOnlyStrictMode"), true);
  assert.equal(config.get("securityProfile"), "strict");
  assert.equal(config.get("runtimeFailOnDependencyPreflightError"), true);
  assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), []);
  assert.deepEqual(config.get("securityPolicy"), {
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
    requireModuleManifestForBareSpecifiers: true,
    requireModuleIntegrity: true,
    allowDynamicSourceImports: false,
  });
});

test("config detaches loaded, set, get, and snapshot values", async () => {
  const config = new DefaultRenderifyConfig();
  const fallbackCdns = ["https://fallback.example"];
  const securityPolicy = {
    allowedNetworkHosts: ["allowed.example"],
    allowArbitraryNetwork: false,
  };

  await config.load({
    runtimeRemoteFallbackCdnBases: fallbackCdns,
    securityPolicy,
  });
  fallbackCdns.push("https://mutated.example");
  securityPolicy.allowedNetworkHosts.push("mutated.example");

  const firstFallbacks = config.get<string[]>("runtimeRemoteFallbackCdnBases");
  const firstPolicy = config.get<typeof securityPolicy>("securityPolicy");
  assert.deepEqual(firstFallbacks, ["https://fallback.example"]);
  assert.deepEqual(firstPolicy?.allowedNetworkHosts, ["allowed.example"]);

  firstFallbacks?.push("https://read-mutation.example");
  firstPolicy?.allowedNetworkHosts.push("read-mutation.example");
  const snapshot = config.snapshot() as {
    securityPolicy: typeof securityPolicy;
  };
  snapshot.securityPolicy.allowedNetworkHosts.push("snapshot-mutation.example");

  const setValue = { nested: { enabled: true } };
  config.set("custom", setValue);
  setValue.nested.enabled = false;

  assert.deepEqual(config.get("runtimeRemoteFallbackCdnBases"), [
    "https://fallback.example",
  ]);
  assert.deepEqual(
    config.get<typeof securityPolicy>("securityPolicy")?.allowedNetworkHosts,
    ["allowed.example"],
  );
  assert.deepEqual(config.get("custom"), { nested: { enabled: true } });
});
