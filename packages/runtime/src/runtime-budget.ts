import { nowMs } from "./runtime-environment";

export interface RuntimeBudgetFrame {
  startedAt: number;
  maxExecutionMs: number;
  signal?: AbortSignal;
}

export function hasExceededBudget(frame: RuntimeBudgetFrame): boolean {
  return nowMs() - frame.startedAt > frame.maxExecutionMs;
}

export function isAborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw createAbortError("Runtime execution aborted");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function withRemainingBudget<T>(
  operation: () => Promise<T>,
  frame: RuntimeBudgetFrame,
  timeoutMessage: string,
): Promise<T> {
  throwIfAborted(frame.signal);
  const remainingMs = frame.maxExecutionMs - (nowMs() - frame.startedAt);
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, remainingMs);
  });

  const signal = frame.signal;
  const abortPromise =
    signal &&
    new Promise<T>((_resolve, reject) => {
      onAbort = () => {
        reject(createAbortError("Runtime execution aborted"));
      };
      signal.addEventListener("abort", onAbort!, { once: true });
    });

  try {
    const pending = abortPromise
      ? [operation(), timeoutPromise, abortPromise]
      : [operation(), timeoutPromise];
    return await Promise.race(pending);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
