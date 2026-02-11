import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/codegen/src/index";

test("codegen parses RuntimePlan JSON output directly", async () => {
  const codegen = new DefaultCodeGenerator();

  const planJson = JSON.stringify({
    id: "codegen_plan",
    version: 3,
    capabilities: {
      domWrite: true,
      maxExecutionMs: 1200,
    },
    state: {
      initial: {
        count: 0,
      },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "Count={{state.count}}" }],
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "Counter plan",
    llmText: planJson,
  });

  assert.equal(plan.id, "codegen_plan");
  assert.equal(plan.version, 3);
  assert.equal(plan.specVersion, "runtime-plan/v1");
  assert.equal(plan.state?.initial.count, 0);
  assert.equal(plan.capabilities.maxExecutionMs, 1200);
  assert.equal(plan.metadata?.sourcePrompt, "Counter plan");
});

test("codegen falls back to section root when no JSON payload exists", async () => {
  const codegen = new DefaultCodeGenerator();

  const plan = await codegen.generatePlan({
    prompt: "Welcome prompt",
    llmText: "plain text output",
  });

  assert.equal(plan.root.type, "element");
  if (plan.root.type !== "element") {
    throw new Error("expected fallback element node");
  }
  assert.equal(plan.root.tag, "section");
  assert.equal(plan.capabilities.domWrite, true);
  assert.equal(plan.specVersion, "runtime-plan/v1");
});

test("codegen extracts tsx source module from fenced output", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    "Here is the runtime component:",
    "```tsx",
    'import { nanoid } from "npm:nanoid@5";',
    "export default () => <section>ID:{nanoid(6)}</section>;",
    "```",
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "tsx module",
    llmText,
  });

  assert.equal(plan.source?.language, "tsx");
  assert.equal(plan.source?.runtime, "preact");
  assert.match(plan.source?.code ?? "", /export default/);
  assert.deepEqual(plan.imports, ["npm:nanoid@5"]);
  assert.equal(
    plan.moduleManifest?.["npm:nanoid@5"]?.resolvedUrl,
    "https://ga.jspm.io/npm:nanoid@5/index.js",
  );
  assert.ok(plan.metadata?.tags?.includes("source-module"));
});

test("codegen preserves source module when RuntimePlan JSON contains source", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_json_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "from source json" }],
    },
    source: {
      language: "tsx",
      code: [
        'import { nanoid } from "npm:nanoid@5";',
        "export default () => <section>{nanoid(4)}</section>;",
      ].join("\n"),
      exportName: "default",
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "source plan json",
    llmText: planJson,
  });

  assert.equal(plan.source?.language, "tsx");
  assert.equal(plan.source?.runtime, "preact");
  assert.match(plan.source?.code ?? "", /nanoid/);
  assert.deepEqual(plan.imports, ["npm:nanoid@5"]);
  assert.equal(
    plan.moduleManifest?.["npm:nanoid@5"]?.resolvedUrl,
    "https://ga.jspm.io/npm:nanoid@5/index.js",
  );
});
