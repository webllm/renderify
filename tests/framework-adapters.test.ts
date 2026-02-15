import assert from "node:assert/strict";
import test from "node:test";
import {
  createSolidAdapterPlugin,
  createSvelteAdapterPlugin,
  createVueAdapterPlugin,
} from "../packages/core/src/framework-adapters";
import type { RuntimePlan } from "../packages/ir/src/index";

test("vue adapter plugin enriches prompt and rewrites vue fences", async () => {
  const plugin = createVueAdapterPlugin({
    runtimeImportPath: "@renderify/runtime",
  });

  const beforeLLM = plugin.hooks.beforeLLM;
  assert.equal(typeof beforeLLM, "function");

  const promptResult = (await beforeLLM?.("build dashboard", {
    traceId: "trace_test",
    hookName: "beforeLLM",
  })) as string;

  assert.match(promptResult, /Framework adapter target: vue\./);
  assert.match(promptResult, /VueAdapter/);

  const beforeCodeGen = plugin.hooks.beforeCodeGen;
  assert.equal(typeof beforeCodeGen, "function");

  const codegenPayload = (await beforeCodeGen?.(
    {
      prompt: "build dashboard",
      llmText: "```vue\n<div/>\n```",
      context: {},
    },
    {
      traceId: "trace_test",
      hookName: "beforeCodeGen",
    },
  )) as { llmText: string };

  assert.match(codegenPayload.llmText, /```tsx/);
});

test("framework adapter plugin marks plan metadata and enforces preact runtime", async () => {
  const plugin = createSvelteAdapterPlugin();
  const afterCodeGen = plugin.hooks.afterCodeGen;
  assert.equal(typeof afterCodeGen, "function");

  const plan: RuntimePlan = {
    specVersion: "runtime-plan/v1",
    id: "framework_adapter_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "hello" }],
    },
    source: {
      language: "tsx",
      code: "export default function App(){ return <div/>; }",
      runtime: "renderify",
    },
  };

  const next = (await afterCodeGen?.(plan, {
    traceId: "trace_test",
    hookName: "afterCodeGen",
  })) as RuntimePlan;

  assert.equal(next.source?.runtime, "preact");
  assert.equal(
    (next.metadata as { frameworkAdapter?: { framework?: string } })
      ?.frameworkAdapter?.framework,
    "svelte",
  );
});

test("solid adapter plugin rewrites solid code fences", async () => {
  const plugin = createSolidAdapterPlugin();
  const beforeCodeGen = plugin.hooks.beforeCodeGen;
  assert.equal(typeof beforeCodeGen, "function");

  const payload = (await beforeCodeGen?.(
    {
      prompt: "build chart",
      llmText: "```solid-js\nconst App = () => <div/>\n```",
      context: {},
    },
    {
      traceId: "trace_test",
      hookName: "beforeCodeGen",
    },
  )) as { llmText: string };

  assert.match(payload.llmText, /```tsx/);
  assert.doesNotMatch(payload.llmText, /```solid-js/);
});
