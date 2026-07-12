/**
 * Official MCP Apps adapter for offline, declarative Renderify RuntimePlans.
 *
 * Runtime source, remote modules, component nodes, browser storage, timers, and
 * undeclared app-to-tool calls are intentionally outside this package's trust
 * boundary.
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
