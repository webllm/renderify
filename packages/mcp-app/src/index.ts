/**
 * Official MCP Apps adapter for offline, declarative Renderify RuntimePlans.
 *
 * Remote modules, component nodes, browser storage, timers, and undeclared
 * app-to-tool calls are intentionally outside this package's trust boundary.
 * Apps that opt into `sourceMode` may render model-written source, but only in
 * a sandboxed frame nested in the view, never in the view's own window.
 *
 * @packageDocumentation
 */

export * from "./bundle";
export * from "./plan";
export * from "./server";
export * from "./shell";
export {
  createRenderifyModelContext,
  type RenderifyMcpViewConfig,
  type RenderifyMcpViewController,
  type RenderifyMcpViewDependencies,
  startRenderifyMcpApp,
} from "./view";
