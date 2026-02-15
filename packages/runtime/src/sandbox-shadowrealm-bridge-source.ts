export function buildShadowRealmBridgeSource(moduleUrl: string): string {
  const moduleUrlLiteral = JSON.stringify(moduleUrl);

  return /* js */ `
import * as __renderify_ns from ${moduleUrlLiteral};
function __renderify_message(error) {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}
export async function __renderify_run(serializedRuntimeInput, exportName) {
  try {
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
