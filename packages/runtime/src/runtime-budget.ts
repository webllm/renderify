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
  operation: (signal?: AbortSignal) => Promise<T>,
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
  let timedOut = false;
  const operationController =
    typeof AbortController === "undefined" ? undefined : new AbortController();

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      operationController?.abort();
      reject(new Error(timeoutMessage));
    }, remainingMs);
  });

  const signal = frame.signal;
  const abortPromise =
    signal &&
    new Promise<T>((_resolve, reject) => {
      const handleAbort = () => {
        operationController?.abort();
        reject(createAbortError("Runtime execution aborted"));
      };
      onAbort = handleAbort;
      signal.addEventListener("abort", handleAbort, { once: true });
    });

  try {
    const operationPromise = operation(
      operationController?.signal ?? frame.signal,
    );
    const pending = abortPromise
      ? [operationPromise, timeoutPromise, abortPromise]
      : [operationPromise, timeoutPromise];
    try {
      return await Promise.race(pending);
    } catch (error) {
      if (timedOut && !frame.signal?.aborted) {
        throw new Error(timeoutMessage);
      }
      throw error;
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    operationController?.abort();
  }
}
