import assert from "node:assert/strict";
import test from "node:test";
import { DefaultLLMInterpreter } from "../packages/core/src/llm-interpreter";

test("llm structured response returns runtime-plan payload", async () => {
  const llm = new DefaultLLMInterpreter();
  llm.configure({
    model: "mock-structured",
  });

  const response = await llm.generateStructuredResponse({
    prompt: "Build counter UI",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  assert.equal(typeof response.text, "string");
  assert.ok(response.text.startsWith("{"));
  assert.equal(response.model, "mock-structured");
});

test("llm can mock invalid structured response for fallback branch", async () => {
  const llm = new DefaultLLMInterpreter();
  llm.configure({
    mockStructuredInvalid: true,
  });

  const response = await llm.generateStructuredResponse({
    prompt: "Invalid case",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, false);
  assert.ok((response.errors ?? []).length > 0);
});

test("llm streaming response yields incremental chunks", async () => {
  const llm = new DefaultLLMInterpreter();
  llm.configure({
    model: "mock-stream",
    streamChunkSize: 24,
  });

  const chunks = [];
  for await (const chunk of llm.generateResponseStream?.({
    prompt: "Build runtime stream preview",
  }) ?? []) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[chunks.length - 1]?.done, true);
  assert.ok(chunks[chunks.length - 1]?.text.includes("runtime stream preview"));
});

test("llm structured dashboard prompt returns preact runtime source plan", async () => {
  const llm = new DefaultLLMInterpreter();
  llm.configure({
    model: "mock-dashboard",
  });

  const response = await llm.generateStructuredResponse({
    prompt: "Build analytics dashboard with chart and KPI toggles",
    format: "runtime-plan",
    strict: true,
  });

  assert.equal(response.valid, true);
  const parsed = JSON.parse(response.text) as Record<string, unknown>;
  const source = parsed.source as Record<string, unknown> | undefined;

  assert.equal(source?.runtime, "preact");
  assert.equal(source?.language, "tsx");
  assert.match(String(source?.code ?? ""), /recharts/);
  assert.equal(
    (parsed.moduleManifest as Record<string, { resolvedUrl?: string }>)
      ?.recharts?.resolvedUrl,
    "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
  );
});
