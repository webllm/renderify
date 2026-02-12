import type { JsonValue } from "@renderify/ir";
import type { RuntimeSourceSandboxMode } from "./manager";

export interface RuntimeSandboxResult {
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

  if (options.mode === "worker") {
    return executeSourceInWorkerSandbox(options);
  }

  if (options.mode === "iframe") {
    return executeSourceInIframeSandbox(options);
  }

  throw new Error(`Unsupported runtime source sandbox mode: ${options.mode}`);
}

async function executeSourceInWorkerSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  if (
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Worker sandbox is unavailable in this runtime");
  }

  const workerSource = [
    "const CHANNEL = 'runtime-source';",
    "self.onmessage = async (event) => {",
    "  const request = event.data;",
    "  if (!request || request.renderifySandbox !== CHANNEL) {",
    "    return;",
    "  }",
    "  const safeSend = (payload) => {",
    "    try {",
    "      self.postMessage({ renderifySandbox: CHANNEL, id: request.id, ...payload });",
    "      return true;",
    "    } catch (postError) {",
    "      try {",
    "        const postMessageError = postError && typeof postError === 'object' && 'message' in postError",
    "          ? String(postError.message)",
    "          : String(postError);",
    "        self.postMessage({",
    "          renderifySandbox: CHANNEL,",
    "          id: request.id,",
    "          ok: false,",
    "          error: `Sandbox response is not serializable: ${postMessageError}`,",
    "        });",
    "      } catch {",
    "        // Ignore terminal postMessage failures.",
    "      }",
    "      return false;",
    "    }",
    "  };",
    "  try {",
    "    const moduleUrl = URL.createObjectURL(new Blob([String(request.code ?? '')], { type: 'text/javascript' }));",
    "    try {",
    "      const namespace = await import(moduleUrl);",
    "      const exportName = typeof request.exportName === 'string' && request.exportName.trim().length > 0",
    "        ? request.exportName.trim()",
    "        : 'default';",
    "      const selected = namespace[exportName];",
    "      if (selected === undefined) {",
    '        throw new Error(`Runtime source export "${exportName}" is missing`);',
    "      }",
    "      const output = typeof selected === 'function'",
    "        ? await selected(request.runtimeInput ?? {})",
    "        : selected;",
    "      safeSend({ ok: true, output });",
    "    } finally {",
    "      URL.revokeObjectURL(moduleUrl);",
    "    }",
    "  } catch (error) {",
    "    const message = error && typeof error === 'object' && 'message' in error",
    "      ? String(error.message)",
    "      : String(error);",
    "    safeSend({ ok: false, error: message });",
    "  }",
    "};",
  ].join("\n");

  const workerUrl = URL.createObjectURL(
    new Blob([workerSource], {
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

    worker.postMessage(options.request);
  });
}

async function executeSourceInIframeSandbox(
  options: RuntimeSandboxExecutionOptions,
): Promise<RuntimeSandboxResult> {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Iframe sandbox is unavailable in this runtime");
  }

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.display = "none";

  const channel = `renderify-runtime-source-${options.request.id}`;
  const channelLiteral = JSON.stringify(channel);

  iframe.srcdoc = [
    "<!doctype html><html><body><script>",
    `const CHANNEL = ${channelLiteral};`,
    "window.addEventListener('message', async (event) => {",
    "  const data = event.data;",
    "  if (!data || data.channel !== CHANNEL) {",
    "    return;",
    "  }",
    "  const request = data.request || {};",
    "  const safeSend = (payload) => {",
    "    try {",
    "      parent.postMessage({ channel: CHANNEL, ...payload }, '*');",
    "      return true;",
    "    } catch (postError) {",
    "      try {",
    "        const postMessageError = postError && typeof postError === 'object' && 'message' in postError",
    "          ? String(postError.message)",
    "          : String(postError);",
    "        parent.postMessage({",
    "          channel: CHANNEL,",
    "          ok: false,",
    "          error: `Sandbox response is not serializable: ${postMessageError}`,",
    "        }, '*');",
    "      } catch {",
    "        // Ignore terminal postMessage failures.",
    "      }",
    "      return false;",
    "    }",
    "  };",
    "  try {",
    "    const moduleUrl = URL.createObjectURL(new Blob([String(request.code ?? '')], { type: 'text/javascript' }));",
    "    try {",
    "      const namespace = await import(moduleUrl);",
    "      const exportName = typeof request.exportName === 'string' && request.exportName.trim().length > 0",
    "        ? request.exportName.trim()",
    "        : 'default';",
    "      const selected = namespace[exportName];",
    "      if (selected === undefined) {",
    '        throw new Error(`Runtime source export "${exportName}" is missing`);',
    "      }",
    "      const output = typeof selected === 'function'",
    "        ? await selected(request.runtimeInput ?? {})",
    "        : selected;",
    "      safeSend({ ok: true, output });",
    "    } finally {",
    "      URL.revokeObjectURL(moduleUrl);",
    "    }",
    "  } catch (error) {",
    "    const message = error && typeof error === 'object' && 'message' in error",
    "      ? String(error.message)",
    "      : String(error);",
    "    safeSend({ ok: false, error: message });",
    "  }",
    "});",
    "</script></body></html>",
  ].join("");

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
        output: data.output,
      });
    };

    const onLoad = () => {
      iframe.contentWindow?.postMessage(
        { channel, request: options.request },
        "*",
      );
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
