import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerRenderifyApp, renderifyToolResult } from "@renderify/mcp-app";
import { z } from "zod";
import { buildTaskBoard, type Task } from "./tasks";

// In-memory store; replace with your own persistence and authorization.
const tasks: Task[] = [
  { id: 1, title: "Connect this server to an MCP Apps host", done: true },
  { id: 2, title: "Ask the model to show your tasks", done: false },
];
let nextId = 3;

const server = new McpServer({
  name: "renderify-task-board",
  version: "1.0.0",
});

// The display tool and the UI resource it renders in.
await registerRenderifyApp(server, {
  uri: "ui://renderify-task-board/board",
  name: "Task board",
  description: "Interactive task board rendered from a Renderify RuntimePlan",
  toolName: "show_tasks",
  toolDescription: "Show the user's task board",
  // The view may call only these tools, and only from plan events.
  allowedTools: ["add_task", "complete_task"],
  handler: () => buildTaskBoard(tasks),
});

// Tools the view calls. Their arguments come from what the user typed, so
// validate them like any other untrusted input.
server.registerTool(
  "add_task",
  {
    description: "Add a task to the board",
    inputSchema: z.object({ title: z.string().trim().min(1).max(200) }),
  },
  async ({ title }) => {
    tasks.push({ id: nextId++, title, done: false });
    return renderifyToolResult(
      { plan: buildTaskBoard(tasks) },
      { summary: `Added "${title}".` },
    );
  },
);

server.registerTool(
  "complete_task",
  {
    description: "Mark a task as done",
    inputSchema: z.object({ id: z.number().int().positive() }),
  },
  async ({ id }) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) {
      task.done = true;
    }
    return renderifyToolResult(
      { plan: buildTaskBoard(tasks) },
      { summary: task ? `Completed "${task.title}".` : `No task ${id}.` },
    );
  },
);

await server.connect(new StdioServerTransport());

process.once("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
