import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRenderifyApp } from "@renderify/mcp-app";
import { z } from "zod";
import { buildDashboardPlan } from "./dashboard-plan";

const dashboardInput = z.object({
  title: z.string().min(1).default("Team dashboard"),
  activeUsers: z.number().int().nonnegative().default(42),
});

const server = new McpServer({
  name: "renderify-mcp-example",
  version: "1.0.0",
});

await registerRenderifyApp(server, {
  uri: "ui://renderify-example/dashboard",
  name: "Renderify dashboard",
  description: "Offline interactive dashboard rendered from a RuntimePlan",
  toolName: "show_dashboard",
  toolDescription: "Show an offline interactive dashboard",
  toolInputSchema: dashboardInput,
  handler: (args) => buildDashboardPlan(dashboardInput.parse(args)),
});

await server.connect(new StdioServerTransport());

process.once("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
