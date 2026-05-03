const DISABLED_SANDBOX_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document",
  "navigator",
  "process",
  "require",
];

export const RUNTIME_SOURCE_GLOBAL_HARDENING_SOURCE = /* js */ `
function __renderify_disable_runtime_source_global(name) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: undefined,
    });
  } catch {
    try {
      globalThis[name] = undefined;
    } catch {
      // Ignore globals that the host refuses to shadow.
    }
  }
}

function __renderify_harden_runtime_source_globals() {
  for (const name of ${JSON.stringify(DISABLED_SANDBOX_GLOBALS)}) {
    __renderify_disable_runtime_source_global(name);
  }
}
`.trim();

export const RUNTIME_SOURCE_MODULE_PREAMBLE = /* js */ `
const __renderify_disabled_global = undefined;
const fetch = __renderify_disabled_global;
const XMLHttpRequest = __renderify_disabled_global;
const WebSocket = __renderify_disabled_global;
const importScripts = __renderify_disabled_global;
const localStorage = __renderify_disabled_global;
const sessionStorage = __renderify_disabled_global;
const indexedDB = __renderify_disabled_global;
const document = __renderify_disabled_global;
const navigator = __renderify_disabled_global;
const process = __renderify_disabled_global;
const require = __renderify_disabled_global;
const self = __renderify_disabled_global;
const window = __renderify_disabled_global;
const globalThis = __renderify_disabled_global;
`.trim();

export function wrapRuntimeSourceForSandbox(code: string): string {
  return `${RUNTIME_SOURCE_MODULE_PREAMBLE}\n${code}`;
}
