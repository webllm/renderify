/**
 * A runnable MCP server that exposes Renderify as MCP Apps generative UI.
 *
 * It registers:
 *   - a `ui://renderify-demo/dashboard` resource = the static, pre-auditable
 *     Renderify shell (self-contained, strict hash-based CSP), and
 *   - a `render_kpi_dashboard` tool whose result renders into that resource.
 *
 * Run it directly over stdio and point an MCP Apps host (e.g. MCPJam inspector)
 * at it — see README.md. The factory is exported so it can be driven in-process
 * by tests with an in-memory transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  bundleBrowserRuntime,
  planPayload,
  type RegisterableMcpServer,
  type RenderifyUiResource,
  registerRenderifyApp,
} from "@renderify/mcp-app";
import { z } from "zod";
import { buildDashboardPlan } from "./dashboard-plan";

export interface RenderifyDemoServer {
  server: McpServer;
  resource: RenderifyUiResource;
}

/**
 * Build the demo server. The runtime bundle is produced once and inlined into
 * the shell, so the resulting UI renders with zero network access.
 */
export async function createRenderifyDemoServer(): Promise<RenderifyDemoServer> {
  const runtimeBundle = (
    await bundleBrowserRuntime({
      runtimeEntry: "@renderify/runtime",
      resolveDir: process.cwd(),
    })
  ).code;

  const server = new McpServer({
    name: "renderify-mcp-app-demo",
    version: "0.1.0",
  });

  const resource = await registerRenderifyApp(
    server as unknown as RegisterableMcpServer,
    {
      server: "renderify-demo",
      name: "dashboard",
      mode: "self-contained",
      runtimeBundle,
      useScriptHashes: true,
      securityProfile: "balanced",
      autoPinModules: false,
      toolName: "render_kpi_dashboard",
      toolDescription:
        "Render an interactive KPI dashboard as generative UI inside the MCP Apps surface.",
      toolInputSchema: {
        title: z.string().optional().describe("Dashboard heading"),
      },
      visibility: ["app", "model"],
      handler: (args) => {
        const input = (args ?? {}) as { title?: string };
        return planPayload(buildDashboardPlan({ title: input.title }));
      },
    },
  );

  return { server, resource };
}

async function main(): Promise<void> {
  const { server } = await createRenderifyDemoServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout carries the JSON-RPC stream.
  process.stderr.write(
    "[renderify-mcp-app-demo] ready on stdio; tool: render_kpi_dashboard\n",
  );
}

// Run over stdio when executed directly (not when imported by a test).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /server\.(ts|js|mjs)$/.test(process.argv[1] ?? "");

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[renderify-mcp-app-demo] fatal: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
