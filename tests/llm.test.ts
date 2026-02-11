import assert from "node:assert/strict";
import test from "node:test";
import { DefaultLLMInterpreter } from "../packages/llm-interpreter/src/index";

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
