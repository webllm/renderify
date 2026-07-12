/**
 * @renderify/mcp-app — MCP Apps (SEP-1865) adapter for Renderify.
 *
 * MCP Apps standardizes the "envelope" for interactive UI in MCP clients: a
 * `ui://` resource rendered in a sandboxed iframe, talking to the host over
 * JSON-RPC on postMessage. The spec is deliberately agnostic about *how* the UI
 * is produced — from predefined templates to declarative JSON to fully
 * generative. This package fills the generative slot: it serves a static,
 * pre-auditable shell whose embedded Renderify runtime executes the model's
 * TSX/JSON arriving as data in tool results.
 *
 * @packageDocumentation
 */

export {
  type BundleBrowserRuntimeOptions,
  type BundleEsmModuleOptions,
  type BundleResult,
  bundleBrowserRuntime,
  bundleEsmModule,
} from "./bundle";
export * from "./csp";
export * from "./event-bridge";
export * from "./protocol";
export {
  type CreateRenderifyUiResourceOptions,
  createRenderifyUiResource,
  planPayload,
  type RegisterableMcpServer,
  type RegisterRenderifyAppOptions,
  type RenderifyToolResult,
  type RenderifyUiPayload,
  type RenderifyUiResource,
  registerRenderifyApp,
  renderifyToolMeta,
  renderifyToolResult,
  sourcePayload,
} from "./server";
export {
  type CreateRenderifyShellOptions,
  createRenderifyShell,
  type RenderifyShell,
  type SecurityProfile,
} from "./shell";
export {
  buildShellBridgeScript,
  RENDERIFY_SHELL_BRIDGE_BODY,
  type ShellBridgeRuntimeConfig,
} from "./shell-bridge-source";
export {
  type AssembleShellOptions,
  assembleShellDocument,
  type BuildShellHtmlOptions,
  buildRenderifyShellHtml,
  buildRuntimeLoaderScript,
  DEFAULT_MOUNT_ID,
  RENDERIFY_READY_BOOTSTRAP,
  RENDERIFY_SHELL_STYLE,
  type RuntimeLoader,
  type ShellInlineScript,
} from "./shell-template";
