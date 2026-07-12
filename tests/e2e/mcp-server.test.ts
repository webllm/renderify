/**
 * Drives the example MCP server through the real @modelcontextprotocol/sdk
 * client over an in-memory transport. This is the automated equivalent of
 * pointing MCPJam inspector at the server: it proves the resource + tool wiring
 * speaks MCP correctly and that the tool result carries the Renderify payload.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_UI_EXTENSION_ID, MCP_UI_HTML_MIME_TYPE } from "@renderify/mcp-app";
import { createRenderifyDemoServer } from "../../examples/mcp-app/server";

test("mcp-server: lists the ui resource and renderify tool", async () => {
  const { server } = await createRenderifyDemoServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "render_kpi_dashboard");
    assert.ok(tool, "render_kpi_dashboard tool not listed");
    const toolUiMeta = tool?._meta?.ui as { resourceUri?: string } | undefined;
    assert.equal(toolUiMeta?.resourceUri, "ui://renderify-demo/dashboard");

    const resources = await client.listResources();
    const resource = resources.resources.find(
      (r) => r.uri === "ui://renderify-demo/dashboard",
    );
    assert.ok(resource, "ui resource not listed");
    assert.equal(resource?.mimeType, MCP_UI_HTML_MIME_TYPE);
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp-server: resource read returns a pre-auditable shell with CSP", async () => {
  const { server } = await createRenderifyDemoServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const read = await client.readResource({
      uri: "ui://renderify-demo/dashboard",
    });
    const content = read.contents[0];
    assert.equal(content.mimeType, MCP_UI_HTML_MIME_TYPE);
    const html = "text" in content ? String(content.text) : "";
    assert.notEqual(html, "", "resource content is not text");
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src[^"]*sha256-/);
    assert.match(html, /RenderifyRuntime/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp-server: tool call returns a renderify render payload", async () => {
  const { server } = await createRenderifyDemoServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "render_kpi_dashboard",
      arguments: { title: "Q3 metrics" },
    });
    const structured = result.structuredContent as
      | { renderify?: { plan?: { id?: string; root?: unknown } } }
      | undefined;
    assert.ok(
      structured?.renderify?.plan,
      "tool result missing renderify plan",
    );
    assert.equal(structured?.renderify?.plan?.id, "renderify-mcp-dashboard");
    assert.ok(structured?.renderify?.plan?.root, "plan has no root node");
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp-server: extension id constant is exported for capability negotiation", () => {
  assert.equal(MCP_UI_EXTENSION_ID, "io.modelcontextprotocol/ui");
});
