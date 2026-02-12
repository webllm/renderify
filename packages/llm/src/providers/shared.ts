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
