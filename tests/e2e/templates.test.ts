import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isRuntimePlan } from "../../packages/ir/src/index";
import { parseDeclarativeMcpPlan } from "../../packages/mcp-app/src/index";

const TEMPLATE_DIR = path.join(process.cwd(), "templates/mcp-server");

interface RenderifyStructuredContent {
  renderify?: { plan?: unknown };
}

function readTasks(result: { structuredContent?: unknown }) {
  const plan = (result.structuredContent as RenderifyStructuredContent)
    ?.renderify?.plan;
  assert.ok(isRuntimePlan(plan), "tool result does not carry a RuntimePlan");
  // The same validator the MCP view applies before rendering.
  parseDeclarativeMcpPlan(plan);
  return (plan.state?.initial.tasks ?? []) as Array<{
    id: number;
    title: string;
    done: boolean;
  }>;
}

test("e2e: the MCP server template serves an interactive task board", async () => {
  const client = new Client({ name: "template-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: TEMPLATE_DIR,
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "add_task",
      "complete_task",
      "show_tasks",
    ]);
    const display = tools.find((tool) => tool.name === "show_tasks");
    assert.match(
      JSON.stringify(display?._meta ?? {}),
      /ui:\/\/renderify-task-board\/board/,
    );

    const shown = await client.callTool({ name: "show_tasks", arguments: {} });
    assert.equal(readTasks(shown).length, 2);

    const resource = await client.readResource({
      uri: "ui://renderify-task-board/board",
    });
    const html = String(
      (resource.contents[0] as { text?: string } | undefined)?.text ?? "",
    );
    assert.match(html, /add_task/);
    assert.match(html, /complete_task/);

    // What the view sends when the form is submitted and a row is completed.
    const added = await client.callTool({
      name: "add_task",
      arguments: { title: "Write the release notes" },
    });
    const afterAdd = readTasks(added);
    assert.equal(afterAdd.at(-1)?.title, "Write the release notes");

    const completed = await client.callTool({
      name: "complete_task",
      arguments: { id: afterAdd.at(-1)?.id },
    });
    assert.equal(readTasks(completed).at(-1)?.done, true);

    const invalid = await client.callTool({
      name: "add_task",
      arguments: { title: "" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
