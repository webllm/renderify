import { RUNTIME_SOURCE_GLOBAL_HARDENING_SOURCE } from "./sandbox-hardening-source";

export function buildShadowRealmBridgeSource(moduleUrl: string): string {
  const moduleUrlLiteral = JSON.stringify(moduleUrl);

  return /* js */ `
${RUNTIME_SOURCE_GLOBAL_HARDENING_SOURCE}
let __renderify_ns_promise;
function __renderify_message(error) {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}
async function __renderify_load_module() {
  __renderify_harden_runtime_source_globals();
  return import(${moduleUrlLiteral});
}
export async function __renderify_run(serializedRuntimeInput, exportName) {
  try {
    const __renderify_ns = await (
      __renderify_ns_promise ?? (__renderify_ns_promise = __renderify_load_module())
    );
    const selectedExportName =
      typeof exportName === "string" && exportName.trim().length > 0
        ? exportName.trim()
        : "default";
    const selected = __renderify_ns[selectedExportName];
    if (selected === undefined) {
      throw new Error(
        'Runtime source export "' + selectedExportName + '" is missing',
      );
    }
    const runtimeInput =
      typeof serializedRuntimeInput === "string" &&
      serializedRuntimeInput.length > 0
        ? JSON.parse(serializedRuntimeInput)
        : {};
    const output =
      typeof selected === "function" ? await selected(runtimeInput) : selected;
    return JSON.stringify({ ok: true, output });
  } catch (error) {
    return JSON.stringify({ ok: false, error: __renderify_message(error) });
  }
}
`.trim();
}
