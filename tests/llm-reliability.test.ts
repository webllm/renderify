import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSseEvents,
  createLLMReliabilityState,
  createTimeoutAbortScope,
  fetchWithReliability,
  pickLLMReliabilityOptions,
  resolveLLMReliabilityOptions,
  withTimeoutAbortScope,
} from "../packages/llm/src/providers/shared";

test("llm reliability resolves and clamps options", () => {
  const resolved = resolveLLMReliabilityOptions({
    maxRetries: 999,
    retryBaseDelayMs: -5,
    retryMaxDelayMs: 2,
    retryJitterMs: 20_000,
    retryStatusCodes: [200, 429, 700, 503],
    circuitBreakerFailureThreshold: 0,
    circuitBreakerCooldownMs: 999_999,
  });

  assert.equal(resolved.maxRetries, 10);
  assert.equal(resolved.retryBaseDelayMs, 1);
  assert.equal(resolved.retryMaxDelayMs, 2);
  assert.equal(resolved.retryJitterMs, 10_000);
  assert.deepEqual(
    [...resolved.retryStatusCodes].sort((a, b) => a - b),
    [200, 429, 503],
  );
  assert.equal(resolved.circuitBreakerFailureThreshold, 1);
  assert.equal(resolved.circuitBreakerCooldownMs, 300_000);
});

test("llm reliability picks nested and flat reliability settings", () => {
  const picked = pickLLMReliabilityOptions({
    llmMaxRetries: 1,
    reliability: {
      maxRetries: 4,
      retryOnNetworkError: false,
      retryStatusCodes: "429,503",
    },
  });

  assert.deepEqual(picked, {
    maxRetries: 4,
    retryOnNetworkError: false,
    retryStatusCodes: [429, 503],
  });
});

test("llm reliability retries retryable status responses", async () => {
  let attempts = 0;
  const state = createLLMReliabilityState();

  const reliability = resolveLLMReliabilityOptions({
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    retryJitterMs: 0,
  });

  const response = await fetchWithReliability({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 2) {
        return new Response("retry", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    },
    input: "https://llm.example.test",
    init: {},
    reliability,
    state,
    operationName: "llm fetch",
  });

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
  assert.equal(state.failures, 0);
  assert.equal(state.openUntil, 0);
});

test("llm reliability does not retry network errors when disabled", async () => {
  let attempts = 0;
  const state = createLLMReliabilityState();

  const reliability = resolveLLMReliabilityOptions({
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    retryJitterMs: 0,
    retryOnNetworkError: false,
  });

  await assert.rejects(
    () =>
      fetchWithReliability({
        fetchImpl: async () => {
          attempts += 1;
          throw new Error("network down");
        },
        input: "https://llm.example.test",
        init: {},
        reliability,
        state,
        operationName: "llm fetch",
      }),
    /network down/,
  );

  assert.equal(attempts, 1);
});

test("llm reliability applies exponential retry delays", async () => {
  const state = createLLMReliabilityState();
  const durations: number[] = [];

  const originalSetTimeout = globalThis.setTimeout;
  const patchedSetTimeout: typeof setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    durations.push(Number(timeout ?? 0));
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;
  globalThis.setTimeout = patchedSetTimeout;

  try {
    const reliability = resolveLLMReliabilityOptions({
      maxRetries: 2,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
      retryJitterMs: 0,
      retryOnNetworkError: true,
    });

    await assert.rejects(
      () =>
        fetchWithReliability({
          fetchImpl: async () => {
            throw new Error("network boom");
          },
          input: "https://llm.example.test",
          init: {},
          reliability,
          state,
          operationName: "llm fetch",
        }),
      /network boom/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  const retryDelays = durations.filter((value) => value >= 5);
  assert.deepEqual(retryDelays.slice(0, 2), [5, 10]);
});

test("llm reliability circuit breaker opens and recovers after cooldown", async () => {
  const state = createLLMReliabilityState();
  const reliability = resolveLLMReliabilityOptions({
    maxRetries: 0,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerCooldownMs: 500,
  });

  let now = 1000;
  const originalDateNow = Date.now;
  Date.now = () => now;

  let attempts = 0;
  try {
    const first = await fetchWithReliability({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("fail", { status: 503 });
      },
      input: "https://llm.example.test",
      init: {},
      reliability,
      state,
      operationName: "llm fetch",
    });

    assert.equal(first.status, 503);
    assert.equal(attempts, 1);

    await assert.rejects(
      () =>
        fetchWithReliability({
          fetchImpl: async () => {
            attempts += 1;
            return new Response("ok", { status: 200 });
          },
          input: "https://llm.example.test",
          init: {},
          reliability,
          state,
          operationName: "llm fetch",
        }),
      /circuit breaker is open/,
    );
    assert.equal(attempts, 1);

    now = 2000;
    const recovered = await fetchWithReliability({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("ok", { status: 200 });
      },
      input: "https://llm.example.test",
      init: {},
      reliability,
      state,
      operationName: "llm fetch",
    });

    assert.equal(recovered.status, 200);
    assert.equal(attempts, 2);
    assert.equal(state.openUntil, 0);
    assert.equal(state.failures, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test("llm reliability consumeSseEvents parses comments and named events", () => {
  const parsed = consumeSseEvents(
    [":comment", "event: delta", "data: hello", "", "data: world", ""].join(
      "\n",
    ),
    true,
  );

  assert.deepEqual(parsed.events, [
    {
      event: "delta",
      data: "hello",
    },
    {
      event: undefined,
      data: "world",
    },
  ]);
  assert.equal(parsed.remaining, "");
});

test("llm reliability consumeSseEvents flushes trailing partial block", () => {
  const buffered = consumeSseEvents("data: partial");
  assert.equal(buffered.events.length, 0);
  assert.equal(buffered.remaining, "data: partial");

  const flushed = consumeSseEvents(buffered.remaining, true);
  assert.deepEqual(flushed.events, [
    {
      event: undefined,
      data: "partial",
    },
  ]);
  assert.equal(flushed.remaining, "");
});

test("llm reliability timeout scope aborts on timeout and upstream signal", async () => {
  const scope = createTimeoutAbortScope(10);

  await new Promise<void>((resolve) => {
    scope.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  scope.release();

  const upstream = new AbortController();
  const scoped = createTimeoutAbortScope(1000, upstream.signal);

  upstream.abort();
  assert.equal(scoped.signal.aborted, true);
  scoped.release();
});

test("llm reliability withTimeoutAbortScope propagates timeout abort", async () => {
  await assert.rejects(
    () =>
      withTimeoutAbortScope(10, undefined, async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
          setTimeout(resolve, 50);
        });

        return "ok";
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
