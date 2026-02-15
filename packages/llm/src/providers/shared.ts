export interface JsonParseResult {
  ok: true;
  value: unknown;
}

export interface JsonParseError {
  ok: false;
  error: string;
}

export interface SseEvent {
  event?: string;
  data: string;
}

export interface TimeoutAbortScope {
  signal: AbortSignal;
  release(): void;
}

export interface LLMReliabilityOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterMs?: number;
  retryOnNetworkError?: boolean;
  retryStatusCodes?: number[];
  circuitBreakerFailureThreshold?: number;
  circuitBreakerCooldownMs?: number;
}

export interface ResolvedLLMReliabilityOptions {
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterMs: number;
  retryOnNetworkError: boolean;
  retryStatusCodes: ReadonlySet<number>;
  circuitBreakerFailureThreshold: number;
  circuitBreakerCooldownMs: number;
}

export interface LLMReliabilityState {
  failures: number;
  openUntil: number;
}

interface FetchWithReliabilityOptions {
  fetchImpl: typeof fetch;
  input: RequestInfo | URL;
  init: RequestInit;
  reliability: ResolvedLLMReliabilityOptions;
  state: LLMReliabilityState;
  operationName: string;
}

const DEFAULT_RETRY_STATUS_CODES = [
  408, 409, 425, 429, 500, 502, 503, 504,
] as const;

const DEFAULT_RELIABILITY: ResolvedLLMReliabilityOptions = {
  maxRetries: 2,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 2000,
  retryJitterMs: 0,
  retryOnNetworkError: true,
  retryStatusCodes: new Set<number>(DEFAULT_RETRY_STATUS_CODES),
  circuitBreakerFailureThreshold: 5,
  circuitBreakerCooldownMs: 15000,
};

export function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

export function pickPositiveInt(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
  }

  return undefined;
}

function pickNonNegativeInt(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
    }
  }

  return undefined;
}

export function pickFetch(
  source: Record<string, unknown>,
  key: string,
): typeof fetch | undefined {
  const value = source[key];
  if (typeof value === "function") {
    return value as typeof fetch;
  }

  return undefined;
}

export function pickLLMReliabilityOptions(
  source: Record<string, unknown>,
): LLMReliabilityOptions | undefined {
  const nested = asRecord(source.reliability);
  const nestedOptions = nested
    ? pickLLMReliabilityOptionsFromRecord(nested)
    : undefined;
  const flatOptions = pickLLMReliabilityOptionsFromRecord(source);

  const merged: LLMReliabilityOptions = {
    ...flatOptions,
    ...nestedOptions,
  };

  if (Object.keys(merged).length === 0) {
    return undefined;
  }

  return merged;
}

export function resolveLLMReliabilityOptions(
  options?: LLMReliabilityOptions,
  base: ResolvedLLMReliabilityOptions = DEFAULT_RELIABILITY,
): ResolvedLLMReliabilityOptions {
  const next = {
    maxRetries: clampInt(options?.maxRetries, base.maxRetries, 0, 10),
    retryBaseDelayMs: clampInt(
      options?.retryBaseDelayMs,
      base.retryBaseDelayMs,
      1,
      30_000,
    ),
    retryMaxDelayMs: clampInt(
      options?.retryMaxDelayMs,
      base.retryMaxDelayMs,
      1,
      120_000,
    ),
    retryJitterMs: clampInt(
      options?.retryJitterMs,
      base.retryJitterMs,
      0,
      10_000,
    ),
    retryOnNetworkError:
      typeof options?.retryOnNetworkError === "boolean"
        ? options.retryOnNetworkError
        : base.retryOnNetworkError,
    retryStatusCodes: normalizeStatusCodeSet(
      options?.retryStatusCodes,
      base.retryStatusCodes,
    ),
    circuitBreakerFailureThreshold: clampInt(
      options?.circuitBreakerFailureThreshold,
      base.circuitBreakerFailureThreshold,
      1,
      100,
    ),
    circuitBreakerCooldownMs: clampInt(
      options?.circuitBreakerCooldownMs,
      base.circuitBreakerCooldownMs,
      100,
      300_000,
    ),
  };

  if (next.retryMaxDelayMs < next.retryBaseDelayMs) {
    next.retryMaxDelayMs = next.retryBaseDelayMs;
  }

  return next;
}

export function createLLMReliabilityState(): LLMReliabilityState {
  return {
    failures: 0,
    openUntil: 0,
  };
}

export async function fetchWithReliability(
  options: FetchWithReliabilityOptions,
): Promise<Response> {
  ensureCircuitClosed(options.state, options.operationName);

  const { reliability } = options;
  const maxAttempts = Math.max(1, reliability.maxRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await options.fetchImpl(options.input, options.init);

      const retryableStatus = reliability.retryStatusCodes.has(response.status);
      if (retryableStatus && attempt < maxAttempts) {
        await waitForRetry(attempt, reliability, options.init.signal);
        continue;
      }

      if (isFailureStatus(response.status, reliability)) {
        markFailure(options.state, reliability);
      } else {
        markSuccess(options.state);
      }

      return response;
    } catch (error) {
      if (isAbortError(error) || options.init.signal?.aborted) {
        throw error;
      }

      const canRetry = reliability.retryOnNetworkError && attempt < maxAttempts;
      if (!canRetry) {
        markFailure(options.state, reliability);
        throw error;
      }

      await waitForRetry(attempt, reliability, options.init.signal);
    }
  }

  throw new Error(`${options.operationName} failed: retries exhausted`);
}

export function resolveFetch(
  fetchImpl: typeof fetch | undefined,
  missingMessage: string,
): typeof fetch {
  if (fetchImpl) {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error(missingMessage);
}

export function createTimeoutAbortScope(
  timeoutMs: number,
  upstreamSignal?: AbortSignal,
): TimeoutAbortScope {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let onAbort: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      onAbort = () => {
        controller.abort();
      };
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    release() {
      clearTimeout(timeout);
      if (upstreamSignal && onAbort) {
        upstreamSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export async function withTimeoutAbortScope<T>(
  timeoutMs: number,
  upstreamSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = createTimeoutAbortScope(timeoutMs, upstreamSignal);
  try {
    return await operation(scope.signal);
  } finally {
    scope.release();
  }
}

export function formatContext(
  context: Record<string, unknown> | undefined,
): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  try {
    return JSON.stringify(context);
  } catch {
    return "";
  }
}

export function tryParseJson(raw: string): JsonParseResult | JsonParseError {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const payload = fenced ? fenced[1] : raw;

  try {
    return {
      ok: true,
      value: JSON.parse(payload) as unknown,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readErrorResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    if (body.error?.message) {
      return body.error.message;
    }
    return JSON.stringify(body);
  } catch {
    try {
      return await response.text();
    } catch {
      return "unknown error";
    }
  }
}

export function consumeSseEvents(
  buffer: string,
  flush = false,
): { events: SseEvent[]; remaining: string } {
  const events: SseEvent[] = [];
  const separator = /\r?\n\r?\n/g;
  let cursor = 0;
  let match = separator.exec(buffer);
  while (match) {
    const block = buffer.slice(cursor, match.index);
    const parsed = parseSseEventBlock(block);
    if (parsed) {
      events.push(parsed);
    }
    cursor = match.index + match[0].length;
    match = separator.exec(buffer);
  }

  let remaining = buffer.slice(cursor);
  if (flush) {
    const tail = parseSseEventBlock(remaining);
    if (tail) {
      events.push(tail);
    }
    remaining = "";
  }

  return {
    events,
    remaining,
  };
}

function parseSseEventBlock(block: string): SseEvent | undefined {
  const lines = block.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const data = dataLines.join("\n").trim();
  if (data.length === 0) {
    return undefined;
  }

  return {
    event: eventName,
    data,
  };
}

function pickLLMReliabilityOptionsFromRecord(
  source: Record<string, unknown>,
): LLMReliabilityOptions | undefined {
  const maxRetries = pickNonNegativeInt(source, "maxRetries", "llmMaxRetries");
  const retryBaseDelayMs = pickPositiveInt(
    source,
    "retryBaseDelayMs",
    "llmRetryBaseDelayMs",
  );
  const retryMaxDelayMs = pickPositiveInt(
    source,
    "retryMaxDelayMs",
    "llmRetryMaxDelayMs",
  );
  const retryJitterMs = pickNonNegativeInt(
    source,
    "retryJitterMs",
    "llmRetryJitterMs",
  );
  const circuitBreakerFailureThreshold = pickPositiveInt(
    source,
    "circuitBreakerFailureThreshold",
    "llmCircuitBreakerFailureThreshold",
  );
  const circuitBreakerCooldownMs = pickPositiveInt(
    source,
    "circuitBreakerCooldownMs",
    "llmCircuitBreakerCooldownMs",
  );

  const retryStatusCodes = pickStatusCodes(
    source,
    "retryStatusCodes",
    "llmRetryStatusCodes",
  );
  const retryOnNetworkError = pickBoolean(
    source,
    "retryOnNetworkError",
    "llmRetryOnNetworkError",
  );

  const options: LLMReliabilityOptions = {
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(retryBaseDelayMs !== undefined ? { retryBaseDelayMs } : {}),
    ...(retryMaxDelayMs !== undefined ? { retryMaxDelayMs } : {}),
    ...(retryJitterMs !== undefined ? { retryJitterMs } : {}),
    ...(retryOnNetworkError !== undefined ? { retryOnNetworkError } : {}),
    ...(retryStatusCodes !== undefined ? { retryStatusCodes } : {}),
    ...(circuitBreakerFailureThreshold !== undefined
      ? { circuitBreakerFailureThreshold }
      : {}),
    ...(circuitBreakerCooldownMs !== undefined
      ? { circuitBreakerCooldownMs }
      : {}),
  };

  if (Object.keys(options).length === 0) {
    return undefined;
  }

  return options;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function pickBoolean(
  source: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }

  return undefined;
}

function pickStatusCodes(
  source: Record<string, unknown>,
  ...keys: string[]
): number[] | undefined {
  for (const key of keys) {
    const raw = source[key];
    if (Array.isArray(raw)) {
      const numeric = raw
        .map((value) => Number(value))
        .filter(
          (value) => Number.isInteger(value) && value >= 100 && value <= 599,
        )
        .map((value) => Math.trunc(value));
      if (numeric.length > 0) {
        return [...new Set(numeric)];
      }
      continue;
    }

    if (typeof raw === "string") {
      const numeric = raw
        .split(",")
        .map((value) => Number(value.trim()))
        .filter(
          (value) => Number.isInteger(value) && value >= 100 && value <= 599,
        )
        .map((value) => Math.trunc(value));
      if (numeric.length > 0) {
        return [...new Set(numeric)];
      }
    }
  }

  return undefined;
}

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  if (normalized < min) {
    return min;
  }

  if (normalized > max) {
    return max;
  }

  return normalized;
}

function normalizeStatusCodeSet(
  statusCodes: number[] | undefined,
  fallback: ReadonlySet<number>,
): ReadonlySet<number> {
  if (!Array.isArray(statusCodes) || statusCodes.length === 0) {
    return new Set<number>(fallback);
  }

  const normalized = statusCodes
    .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599)
    .map((value) => Math.trunc(value));

  if (normalized.length === 0) {
    return new Set<number>(fallback);
  }

  return new Set<number>(normalized);
}

function ensureCircuitClosed(
  state: LLMReliabilityState,
  operationName: string,
): void {
  const now = Date.now();

  if (state.openUntil === 0) {
    return;
  }

  if (now >= state.openUntil) {
    state.openUntil = 0;
    state.failures = 0;
    return;
  }

  const remainingMs = Math.max(1, state.openUntil - now);
  throw new Error(
    `${operationName} circuit breaker is open (retry in ${remainingMs}ms)`,
  );
}

function markSuccess(state: LLMReliabilityState): void {
  state.failures = 0;
  state.openUntil = 0;
}

function markFailure(
  state: LLMReliabilityState,
  reliability: ResolvedLLMReliabilityOptions,
): void {
  state.failures += 1;
  if (state.failures >= reliability.circuitBreakerFailureThreshold) {
    state.openUntil = Date.now() + reliability.circuitBreakerCooldownMs;
    state.failures = 0;
  }
}

function isFailureStatus(
  status: number,
  reliability: ResolvedLLMReliabilityOptions,
): boolean {
  return status >= 500 || reliability.retryStatusCodes.has(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function waitForRetry(
  attempt: number,
  reliability: ResolvedLLMReliabilityOptions,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  const base = reliability.retryBaseDelayMs * 2 ** (attempt - 1);
  const delayWithoutJitter = Math.min(base, reliability.retryMaxDelayMs);
  const jitter =
    reliability.retryJitterMs > 0
      ? Math.floor(Math.random() * (reliability.retryJitterMs + 1))
      : 0;

  await sleep(delayWithoutJitter + jitter, signal);
}

function sleep(
  durationMs: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve();
  }

  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      reject(createAbortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, durationMs);
  });
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
