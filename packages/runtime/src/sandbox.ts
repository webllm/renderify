import type { JsonValue } from "@renderify/ir";
import type { RuntimeSourceSandboxMode } from "./runtime-manager.types";
import { buildIframeSandboxSrcdoc } from "./sandbox-iframe-source";
import { buildShadowRealmBridgeSource } from "./sandbox-shadowrealm-bridge-source";
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

interface ShadowRealmLike {
  importValue(specifier: string, bindingName: string): Promise<unknown>;
}

type ShadowRealmConstructor = new () => ShadowRealmLike;

interface ShadowRealmExecutionPayload {
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

  if (options.mode === "worker") {
    if (isWorkerSandboxAvailable()) {
      return executeSourceInWorkerSandbox(options);
    }
    if (isIframeSandboxAvailable()) {
      return executeSourceInIframeSandbox(options);
    }
    throw new Error(
      "Worker sandbox is unavailable and iframe fallback is unavailable in this runtime",
    );
  }

  if (options.mode === "iframe") {
    if (isIframeSandboxAvailable()) {
      return executeSourceInIframeSandbox(options);
    }
    if (isWorkerSandboxAvailable()) {
      return executeSourceInWorkerSandbox(options);
    }
    throw new Error(
      "Iframe sandbox is unavailable and worker fallback is unavailable in this runtime",
    );
  }

  if (options.mode === "shadowrealm") {
    if (isShadowRealmSandboxAvailable()) {
      return executeSourceInShadowRealmSandbox(options);
    }
    if (isWorkerSandboxAvailable()) {
      return executeSourceInWorkerSandbox(options);
    }
    if (isIframeSandboxAvailable()) {
      return executeSourceInIframeSandbox(options);
    }
    throw new Error(
      "ShadowRealm sandbox is unavailable and no browser sandbox fallback is available",
    );
  }

  throw new Error(`Unsupported runtime source sandbox mode: ${options.mode}`);
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

  const worker = new Worker(workerUrl, {
    type: "module",
    name: "renderify-runtime-source-sandbox",
  });
  URL.revokeObjectURL(workerUrl);

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

async function executeSourceInIframeSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  if (!isIframeSandboxAvailable()) {
    throw new Error("Iframe sandbox is unavailable in this runtime");
  }

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.style.display = "none";

  const channel = `renderify-runtime-source-${options.request.id}`;
  const channelLiteral = JSON.stringify(channel);
  iframe.srcdoc = buildIframeSandboxSrcdoc(channelLiteral);

  document.body.appendChild(iframe);

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
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      iframe.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Iframe sandbox timed out"));
    }, options.timeoutMs);

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.contentWindow) {
        return;
      }

      const data = event.data as
        | { channel?: string; ok?: boolean; output?: unknown; error?: string }
        | undefined;
      if (!data || data.channel !== channel) {
        return;
      }

      cleanup();

      if (!data.ok) {
        reject(new Error(data.error ?? "Iframe sandbox execution failed"));
        return;
      }

      resolve({
        mode: "iframe",
        output: data.output,
      });
    };

    const onLoad = () => {
      try {
        if (!iframe.contentWindow) {
          throw new Error("Iframe sandbox contentWindow is unavailable");
        }
        iframe.contentWindow.postMessage(
          { channel, request: options.request },
          "*",
        );
      } catch (error) {
        cleanup();
        reject(
          new Error(
            `Iframe sandbox failed to receive request: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", onLoad, { once: true });

    if (options.signal) {
      if (options.signal.aborted) {
        cleanup();
        reject(createAbortError("Iframe sandbox execution aborted"));
        return;
      }
      onAbort = () => {
        cleanup();
        reject(createAbortError("Iframe sandbox execution aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function executeSourceInShadowRealmSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  const ShadowRealmCtor = getShadowRealmConstructor();
  if (!ShadowRealmCtor || !hasRuntimeModuleBlobSupport()) {
    throw new Error("ShadowRealm sandbox is unavailable in this runtime");
  }

  const moduleUrl = URL.createObjectURL(
    new Blob([String(options.request.code ?? "")], {
      type: "text/javascript",
    }),
  );

  const bridgeCode = buildShadowRealmBridgeSource(moduleUrl);

  const bridgeUrl = URL.createObjectURL(
    new Blob([bridgeCode], {
      type: "text/javascript",
    }),
  );

  try {
    return withSandboxTimeoutAndAbort({
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      timeoutMessage: "ShadowRealm sandbox timed out",
      abortMessage: "ShadowRealm sandbox execution aborted",
      operation: async () => {
        const realm = new ShadowRealmCtor();
        const imported = await realm.importValue(bridgeUrl, "__renderify_run");
        if (typeof imported !== "function") {
          throw new Error(
            'ShadowRealm bridge export "__renderify_run" is not callable',
          );
        }

        const run = imported as (
          serializedRuntimeInput: string,
          exportName: string,
        ) => Promise<unknown>;
        const serializedRuntimeInput = JSON.stringify(
          options.request.runtimeInput ?? {},
        );
        const payload = parseShadowRealmExecutionPayload(
          await run(serializedRuntimeInput, options.request.exportName),
        );

        if (!payload.ok) {
          throw new Error(
            payload.error ?? "ShadowRealm sandbox execution failed",
          );
        }

        return {
          mode: "shadowrealm",
          output: payload.output,
        } satisfies RuntimeSandboxResult;
      },
    });
  } finally {
    URL.revokeObjectURL(bridgeUrl);
    URL.revokeObjectURL(moduleUrl);
  }
}

function parseShadowRealmExecutionPayload(
  value: unknown,
): ShadowRealmExecutionPayload {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as ShadowRealmExecutionPayload;
      if (typeof parsed.ok === "boolean") {
        return parsed;
      }
    } catch {
      throw new Error("ShadowRealm bridge returned invalid JSON payload");
    }
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  ) {
    return value as ShadowRealmExecutionPayload;
  }

  throw new Error("ShadowRealm bridge returned an invalid payload shape");
}

async function withSandboxTimeoutAndAbort<T>(input: {
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  abortMessage: string;
  operation: () => Promise<T>;
}): Promise<T> {
  throwIfAborted(input.signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (input.signal && onAbort) {
        input.signal.removeEventListener("abort", onAbort);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(input.timeoutMessage));
    }, input.timeoutMs);

    if (input.signal) {
      if (input.signal.aborted) {
        cleanup();
        reject(createAbortError(input.abortMessage));
        return;
      }
      onAbort = () => {
        cleanup();
        reject(createAbortError(input.abortMessage));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    input
      .operation()
      .then((result) => {
        cleanup();
        resolve(result);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
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

function getShadowRealmConstructor(): ShadowRealmConstructor | undefined {
  const candidate = (globalThis as { ShadowRealm?: unknown }).ShadowRealm;
  return typeof candidate === "function"
    ? (candidate as ShadowRealmConstructor)
    : undefined;
}

function isWorkerSandboxAvailable(): boolean {
  return typeof Worker === "function" && hasRuntimeModuleBlobSupport();
}

function isIframeSandboxAvailable(): boolean {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    !hasRuntimeModuleBlobSupport()
  ) {
    return false;
  }

  const candidateDocument = document as Partial<Document>;
  const candidateBody = candidateDocument.body as
    | (Partial<HTMLElement> & { appendChild?: (node: Node) => Node })
    | undefined;

  return (
    typeof candidateDocument.createElement === "function" &&
    candidateBody !== undefined &&
    typeof candidateBody.appendChild === "function"
  );
}

function isShadowRealmSandboxAvailable(): boolean {
  return (
    getShadowRealmConstructor() !== undefined && hasRuntimeModuleBlobSupport()
  );
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
