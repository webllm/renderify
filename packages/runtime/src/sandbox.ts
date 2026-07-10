import type { JsonValue } from "@renderify/ir";
import type { RuntimeSourceSandboxMode } from "./runtime-manager.types";
import { wrapRuntimeSourceForSandbox } from "./sandbox-hardening-source";
import { WORKER_SANDBOX_SOURCE } from "./sandbox-worker-source";

export interface RuntimeSandboxResult {
  mode: RuntimeSourceSandboxMode;
  output: unknown;
}

export interface RuntimeSandboxRequest {
  renderifySandbox: "runtime-source";
  id: string;
  code: string;
  exportName: string;
  runtimeInput: Record<string, JsonValue>;
}

interface RuntimeSandboxResponse {
  renderifySandbox: "runtime-source";
  id: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface RuntimeSandboxExecutionOptions {
  mode: RuntimeSourceSandboxMode;
  request: RuntimeSandboxRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function executeSourceInBrowserSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  throwIfAborted(options.signal);
  validateSandboxRequest(options.request);
  const executionOptions = {
    ...options,
    request: createHardenedSandboxRequest(options.request),
  };

  if (
    options.mode === "worker" ||
    options.mode === "iframe" ||
    options.mode === "shadowrealm"
  ) {
    // Iframes and ShadowRealms cannot provide a reliably preemptible boundary
    // for synchronous JavaScript. Route every sandbox request through a Worker
    // so timeout and abort handling can terminate the executing agent.
    if (isWorkerSandboxAvailable()) {
      return executeSourceInWorkerSandbox(executionOptions);
    }
    throw new Error(
      `Runtime source sandbox mode "${options.mode}" requires an available Worker so execution can be terminated`,
    );
  }

  throw new Error(`Unsupported runtime source sandbox mode: ${options.mode}`);
}

function createHardenedSandboxRequest(
  request: RuntimeSandboxRequest,
): RuntimeSandboxRequest {
  return {
    ...request,
    code: wrapRuntimeSourceForSandbox(request.code),
  };
}

async function executeSourceInWorkerSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  if (!isWorkerSandboxAvailable()) {
    throw new Error("Worker sandbox is unavailable in this runtime");
  }

  const workerUrl = URL.createObjectURL(
    new Blob([WORKER_SANDBOX_SOURCE], {
      type: "text/javascript",
    }),
  );

  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      type: "module",
      name: "renderify-runtime-source-sandbox",
    });
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  return new Promise<RuntimeSandboxResult>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    const timer = setTimeout(() => {
      cleanup();
      worker.terminate();
      reject(new Error("Worker sandbox timed out"));
    }, options.timeoutMs);

    const onMessage = (event: MessageEvent<RuntimeSandboxResponse>) => {
      const payload = event.data;
      if (!isRuntimeSandboxResponse(payload, options.request.id)) {
        return;
      }

      cleanup();
      worker.terminate();

      if (!payload.ok) {
        reject(new Error(payload.error ?? "Worker sandbox execution failed"));
        return;
      }

      resolve({
        mode: "worker",
        output: payload.output,
      });
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      worker.terminate();
      reject(
        new Error(
          event.message || "Worker sandbox terminated with an unknown error",
        ),
      );
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    if (options.signal) {
      if (options.signal.aborted) {
        cleanup();
        worker.terminate();
        reject(createAbortError("Worker sandbox execution aborted"));
        return;
      }
      onAbort = () => {
        cleanup();
        worker.terminate();
        reject(createAbortError("Worker sandbox execution aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      worker.postMessage(options.request);
    } catch (error) {
      cleanup();
      worker.terminate();
      reject(
        new Error(
          `Worker sandbox failed to receive request: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

function isRuntimeSandboxResponse(
  value: unknown,
  expectedId: string,
): value is RuntimeSandboxResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimeSandboxResponse>;
  return (
    candidate.renderifySandbox === "runtime-source" &&
    candidate.id === expectedId &&
    typeof candidate.ok === "boolean"
  );
}

function hasRuntimeModuleBlobSupport(): boolean {
  return (
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof URL.revokeObjectURL === "function"
  );
}

function isWorkerSandboxAvailable(): boolean {
  return typeof Worker === "function" && hasRuntimeModuleBlobSupport();
}

function validateSandboxRequest(request: RuntimeSandboxRequest): void {
  if (
    request.renderifySandbox !== "runtime-source" ||
    typeof request.id !== "string" ||
    request.id.trim().length === 0
  ) {
    throw new Error("Invalid runtime sandbox request envelope");
  }

  if (typeof request.code !== "string") {
    throw new Error("Invalid runtime sandbox request code payload");
  }

  if (
    typeof request.exportName !== "string" ||
    request.exportName.trim().length === 0
  ) {
    throw new Error("Invalid runtime sandbox request exportName");
  }

  if (
    typeof request.runtimeInput !== "object" ||
    request.runtimeInput === null ||
    Array.isArray(request.runtimeInput)
  ) {
    throw new Error("Invalid runtime sandbox request runtimeInput");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError("Runtime sandbox execution aborted");
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
