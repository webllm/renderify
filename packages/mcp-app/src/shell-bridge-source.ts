/**
 * The in-iframe bridge script (browser JS, emitted as a string and inlined into
 * the shell document). It is intentionally plain ES2019 with no build step, in
 * the same spirit as the runtime's `sandbox-*-source.ts` browser templates.
 *
 * Responsibilities:
 *   - Speak MCP JSON-RPC over `postMessage` to the host frame.
 *   - Consume `ui/notifications/tool-result` / `tool-input`, locate the
 *     Renderify payload (a RuntimePlan or a TSX/JSX source), and render it with
 *     the runtime exposed at `globalThis.RenderifyRuntime`.
 *   - Forward interaction back to the host: state -> `ui/update-model-context`,
 *     prefixed events -> `tools/call`.
 *   - Inject `localModules` (e.g. an offline preact) as blob-URL manifest
 *     entries before rendering, so the self-contained tier needs no network.
 *
 * The runtime is awaited via `window.__renderifyRuntimeReady`, which the runtime
 * loader (inline IIFE for self-contained, ESM importmap for declared-domains)
 * resolves once `globalThis.RenderifyRuntime` is populated.
 */

import type { ShellBridgeConfig } from "./event-bridge";

/**
 * `localModules`: bare specifier -> browser-ESM source. Each becomes a blob URL
 * pinned into the rendered plan's moduleManifest, so source `import`s resolve
 * with no network round trip (requires `script-src blob:`).
 */
export interface ShellBridgeRuntimeConfig extends ShellBridgeConfig {
  localModules?: Record<string, string>;
}

const RENDERIFY_SHELL_BRIDGE_BODY = `
"use strict";
var CFG = RENDERIFY_SHELL_CONFIG;
var rpcSeq = 0;
var pending = Object.create(null);
var session = null;
var localModuleUrls = null;

function log() {
  if (!CFG.debug) return;
  try { console.log.apply(console, ["[renderify-shell]"].concat([].slice.call(arguments))); } catch (e) {}
}

function hostTarget() {
  // In MCP Apps the host owns the parent frame.
  return window.parent && window.parent !== window ? window.parent : window;
}

function post(message) {
  try { hostTarget().postMessage(message, "*"); } catch (e) { log("postMessage failed", e); }
}

function request(method, params) {
  var id = "renderify-" + (++rpcSeq);
  return new Promise(function (resolve, reject) {
    pending[id] = { resolve: resolve, reject: reject };
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
  });
}

function notify(method, params) {
  post({ jsonrpc: "2.0", method: method, params: params || {} });
}

function reportError(err) {
  var message = err && err.message ? err.message : String(err);
  log("error", message);
  var root = document.getElementById(CFG.mountId);
  if (root) {
    root.setAttribute("data-renderify-error", "1");
    root.textContent = "Renderify shell error: " + message;
  }
  notify(CFG.methods.notifyMessage, { level: "error", logger: "renderify-shell", data: message });
}

// Walk a few likely locations for the Renderify payload in a tool result.
function findRenderifyPayload(params) {
  if (!params || typeof params !== "object") return null;
  var candidates = [];
  var result = params.result || params.toolResult || params;
  candidates.push(result && result.structuredContent);
  candidates.push(result && result._meta);
  candidates.push(params.structuredContent);
  candidates.push(params._meta);
  candidates.push(result);
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c && typeof c === "object" && c.renderify && typeof c.renderify === "object") {
      return c.renderify;
    }
  }
  // Tolerate a bare RuntimePlan in structuredContent.
  if (result && typeof result === "object" && result.root && result.id) {
    return { plan: result };
  }
  // Tolerate raw TSX/JSX text content.
  if (result && Array.isArray(result.content)) {
    for (var j = 0; j < result.content.length; j++) {
      var part = result.content[j];
      if (part && part.type === "text" && typeof part.text === "string") {
        var trimmed = part.text.trim();
        if (trimmed.indexOf("export default") !== -1 || trimmed.indexOf("function App") !== -1) {
          return { source: { language: "tsx", code: part.text } };
        }
      }
    }
  }
  return null;
}

function ensureLocalModuleUrls() {
  if (localModuleUrls) return localModuleUrls;
  localModuleUrls = Object.create(null);
  var mods = CFG.localModules || {};
  for (var spec in mods) {
    if (!Object.prototype.hasOwnProperty.call(mods, spec)) continue;
    try {
      var blob = new Blob([mods[spec]], { type: "text/javascript" });
      localModuleUrls[spec] = URL.createObjectURL(blob);
    } catch (e) {
      log("failed to create blob for", spec, e);
    }
  }
  return localModuleUrls;
}

function planFromPayload(payload) {
  if (payload.plan && typeof payload.plan === "object") {
    return payload.plan;
  }
  if (payload.source && typeof payload.source === "object") {
    return {
      specVersion: "runtime-plan/v1",
      id: payload.id || "renderify-mcp-app",
      version: 1,
      capabilities: payload.capabilities || { domWrite: true },
      root: { type: "element", tag: "div", children: [{ type: "text", value: "Loading..." }] },
      source: payload.source
    };
  }
  return null;
}

function withLocalManifest(plan) {
  var urls = ensureLocalModuleUrls();
  var specs = Object.keys(urls);
  if (specs.length === 0) return plan;
  var manifest = {};
  if (plan.moduleManifest && typeof plan.moduleManifest === "object") {
    for (var k in plan.moduleManifest) {
      if (Object.prototype.hasOwnProperty.call(plan.moduleManifest, k)) manifest[k] = plan.moduleManifest[k];
    }
  }
  for (var i = 0; i < specs.length; i++) {
    var s = specs[i];
    if (!manifest[s]) manifest[s] = { resolvedUrl: urls[s], version: "0.0.0-local" };
  }
  var clone = {};
  for (var p in plan) { if (Object.prototype.hasOwnProperty.call(plan, p)) clone[p] = plan[p]; }
  clone.moduleManifest = manifest;
  return clone;
}

function handleRuntimeEvent(event) {
  if (!event) return;
  syncModelContext(event);
  if (typeof event.type === "string" && event.type.indexOf(CFG.toolEventPrefix) === 0) {
    var name = event.type.slice(CFG.toolEventPrefix.length).trim();
    if (name.length > 0) {
      request(CFG.methods.toolsCall, { name: name, arguments: event.payload || {} }).catch(reportError);
    }
  }
}

function syncModelContext(event) {
  if (!session) return;
  var state;
  try { state = session.getState ? session.getState() : undefined; } catch (e) { state = undefined; }
  var context = { planId: (session.plan && session.plan.id) || "renderify-mcp-app" };
  if (state) context.state = state;
  if (event) context.lastEvent = { type: event.type, payload: event.payload || {} };
  request(CFG.methods.updateModelContext, { context: context }).catch(function () {});
}

function renderPayload(payload) {
  return Promise.resolve(window.__renderifyRuntimeReady).then(function (RT) {
    if (!RT || typeof RT.createInteractiveSession !== "function") {
      throw new Error("RenderifyRuntime is not available in the shell");
    }
    var plan = planFromPayload(payload);
    if (!plan) throw new Error("No Renderify plan or source found in tool result");
    plan = withLocalManifest(plan);
    var teardown = session ? session.terminate().catch(function () {}) : Promise.resolve();
    return teardown.then(function () {
      session = null;
      return RT.createInteractiveSession(plan, {
        target: { element: "#" + CFG.mountId, onRuntimeEvent: function (req) { handleRuntimeEvent(req && req.event); } },
        autoPinLatestModuleManifest: CFG.autoPinModules,
        securityInitialization: { profile: CFG.securityProfile }
      });
    }).then(function (s) {
      session = s;
      log("rendered plan", plan.id);
      syncModelContext(null);
      notify(CFG.methods.notifyMessage, { level: "info", logger: "renderify-shell", data: "rendered:" + plan.id });
    });
  });
}

function onMessage(event) {
  var data = event && event.data;
  if (!data || data.jsonrpc !== "2.0") return;
  if (data.id && pending[data.id]) {
    var p = pending[data.id];
    delete pending[data.id];
    if (data.error) p.reject(new Error((data.error && data.error.message) || "RPC error"));
    else p.resolve(data.result);
    return;
  }
  if (typeof data.method === "string") {
    if (data.method === CFG.methods.toolResult || data.method === CFG.methods.toolInput) {
      var payload = findRenderifyPayload(data.params || {});
      if (payload) {
        renderPayload(payload).catch(reportError);
      } else {
        log("no renderify payload in", data.method);
      }
    } else if (data.method === CFG.methods.resourceTeardown) {
      if (session) session.terminate().catch(function () {});
      session = null;
    }
  }
}

window.addEventListener("message", onMessage);

// Announce the View to the host. Tolerant of hosts that do not respond.
request(CFG.methods.initialize, {
  protocol: "io.modelcontextprotocol/ui",
  capabilities: { renderer: "renderify", generative: true }
}).catch(function () {});
log("shell bridge ready");
`;

/** Render the bridge script with its config baked in. */
export function buildShellBridgeScript(
  config: ShellBridgeRuntimeConfig,
): string {
  const json = JSON.stringify(config);
  return `(function(){var RENDERIFY_SHELL_CONFIG=${json};${RENDERIFY_SHELL_BRIDGE_BODY}})();`;
}

export { RENDERIFY_SHELL_BRIDGE_BODY };
