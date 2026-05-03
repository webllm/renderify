import { RUNTIME_SOURCE_GLOBAL_HARDENING_SOURCE } from "./sandbox-hardening-source";

export const WORKER_SANDBOX_SOURCE = /* js */ `
${RUNTIME_SOURCE_GLOBAL_HARDENING_SOURCE}
const CHANNEL = "runtime-source";
self.onmessage = async (event) => {
  const request = event.data;
  if (!request || request.renderifySandbox !== CHANNEL) {
    return;
  }
  const safeSend = (payload) => {
    try {
      self.postMessage({ renderifySandbox: CHANNEL, id: request.id, ...payload });
      return true;
    } catch (postError) {
      try {
        const postMessageError =
          postError && typeof postError === "object" && "message" in postError
            ? String(postError.message)
            : String(postError);
        self.postMessage({
          renderifySandbox: CHANNEL,
          id: request.id,
          ok: false,
          error: "Sandbox response is not serializable: " + postMessageError,
        });
      } catch {
        // Ignore terminal postMessage failures.
      }
      return false;
    }
  };
  try {
    __renderify_harden_runtime_source_globals();
    const moduleUrl = URL.createObjectURL(
      new Blob([String(request.code ?? "")], { type: "text/javascript" }),
    );
    try {
      const namespace = await import(moduleUrl);
      const exportName =
        typeof request.exportName === "string" &&
        request.exportName.trim().length > 0
          ? request.exportName.trim()
          : "default";
      const selected = namespace[exportName];
      if (selected === undefined) {
        throw new Error(
          'Runtime source export "' + exportName + '" is missing',
        );
      }
      const output =
        typeof selected === "function"
          ? await selected(request.runtimeInput ?? {})
          : selected;
      safeSend({ ok: true, output });
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    safeSend({ ok: false, error: message });
  }
};
`.trim();
