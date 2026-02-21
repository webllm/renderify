import assert from "node:assert/strict";
import test from "node:test";
import {
  type ApiDefinition,
  DefaultApiIntegration,
} from "../packages/core/src/api-integration";

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "fetch");

  Object.defineProperty(root, "fetch", {
    configurable: true,
    writable: true,
    value: impl,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(root, "fetch", descriptor);
    } else {
      delete root.fetch;
    }
  };
}

function registerDefaultApi(
  integration: DefaultApiIntegration,
  overrides: Partial<ApiDefinition> = {},
): void {
  integration.registerApi({
    name: "users",
    endpoint: "https://api.example.test/users",
    method: "GET",
    timeoutMs: 200,
    ...overrides,
  });
}

test("api integration registers and lists apis", () => {
  const integration = new DefaultApiIntegration();

  registerDefaultApi(integration);
  integration.registerApi({
    name: "create",
    endpoint: "https://api.example.test/users",
    method: "POST",
  });

  assert.deepEqual(
    integration
      .listApis()
      .map((api) => api.name)
      .sort(),
    ["create", "users"],
  );
});

test("api integration rejects unknown api names", async () => {
  const integration = new DefaultApiIntegration();

  await assert.rejects(() => integration.callApi("missing"), /API not found/);
});

test("api integration builds GET query params and skips null/undefined values", async () => {
  const integration = new DefaultApiIntegration();
  registerDefaultApi(integration);

  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const restoreFetch = installMockFetch(async (input, init) => {
    seen.push({
      url: String(input),
      init,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  try {
    const response = await integration.callApi<{ ok: boolean }>("users", {
      page: 2,
      keyword: "Ada",
      ignoredNull: null,
      ignoredUndefined: undefined,
    });

    assert.deepEqual(response, { ok: true });
    assert.equal(seen.length, 1);
    const parsed = new URL(seen[0].url);
    assert.equal(parsed.searchParams.get("page"), "2");
    assert.equal(parsed.searchParams.get("keyword"), "Ada");
    assert.equal(parsed.searchParams.has("ignoredNull"), false);
    assert.equal(parsed.searchParams.has("ignoredUndefined"), false);
    assert.equal(seen[0].init?.method, "GET");
  } finally {
    restoreFetch();
  }
});

test("api integration supports relative GET endpoints when appending params", async () => {
  const integration = new DefaultApiIntegration();
  registerDefaultApi(integration, {
    endpoint: "/api/users?existing=1#pane",
  });

  const seenUrls: string[] = [];
  const restoreFetch = installMockFetch(async (input) => {
    seenUrls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  try {
    await integration.callApi("users", {
      page: 2,
      keyword: "Ada",
    });

    assert.deepEqual(seenUrls, [
      "/api/users?existing=1&page=2&keyword=Ada#pane",
    ]);
  } finally {
    restoreFetch();
  }
});

test("api integration sends non-GET params as JSON body", async () => {
  const integration = new DefaultApiIntegration();
  registerDefaultApi(integration, {
    name: "create-user",
    method: "POST",
  });

  let capturedBody = "";
  let capturedMethod = "";

  const restoreFetch = installMockFetch(async (_input, init) => {
    capturedMethod = String(init?.method);
    capturedBody = String(init?.body ?? "");

    return new Response("created", {
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
    });
  });

  try {
    const response = await integration.callApi<string>("create-user", {
      id: "u_1",
      name: "Ada",
    });

    assert.equal(capturedMethod, "POST");
    assert.equal(capturedBody, JSON.stringify({ id: "u_1", name: "Ada" }));
    assert.equal(response, "created");
  } finally {
    restoreFetch();
  }
});

test("api integration throws enriched error for non-OK response", async () => {
  const integration = new DefaultApiIntegration();
  registerDefaultApi(integration);

  const restoreFetch = installMockFetch(async () => {
    return new Response("upstream unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain",
      },
    });
  });

  try {
    await assert.rejects(
      () => integration.callApi("users"),
      /API users failed with 503: upstream unavailable/,
    );
  } finally {
    restoreFetch();
  }
});

test("api integration supports timeout-driven abort", async () => {
  const integration = new DefaultApiIntegration();
  registerDefaultApi(integration, {
    timeoutMs: 15,
  });

  const restoreFetch = installMockFetch(async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  });

  try {
    await assert.rejects(
      () => integration.callApi("users"),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    restoreFetch();
  }
});
