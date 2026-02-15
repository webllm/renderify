export function buildIframeSandboxSrcdoc(channelLiteral: string): string {
  return /* html */ `<!doctype html><html><body><script>
const CHANNEL = ${channelLiteral};
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.type !== "init") {
    return;
  }
  const port = event.ports && event.ports[0];
  if (!port) {
    return;
  }

  const safeSend = (payload) => {
    try {
      port.postMessage({ type: "result", ...payload });
      return true;
    } catch (postError) {
      try {
        const postMessageError =
          postError && typeof postError === "object" && "message" in postError
            ? String(postError.message)
            : String(postError);
        port.postMessage({
          type: "result",
          ok: false,
          error: "Sandbox response is not serializable: " + postMessageError,
        });
      } catch {
        // Ignore terminal postMessage failures.
      }
      return false;
    }
  };

  port.onmessage = async (portEvent) => {
    const envelope = portEvent.data;
    if (!envelope || envelope.type !== "execute") {
      return;
    }
    const request = envelope.request || {};

    try {
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

  if (typeof port.start === "function") {
    port.start();
  }
  port.postMessage({ type: "ready" });
}, { once: true });
</script></body></html>`;
}
