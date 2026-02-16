import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/core/src/codegen";
import { DefaultSecurityChecker } from "../packages/security/src";

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
  assert.equal(plan.capabilities?.maxExecutionMs, 1200);
  assert.equal(plan.metadata?.sourcePrompt, "Counter plan");
});

test("codegen normalizes unsupported specVersion to runtime-plan/v1", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "1.0.0",
    id: "codegen_spec_normalize",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "spec normalize" }],
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "normalize spec version",
    llmText: planJson,
  });

  assert.equal(plan.specVersion, "runtime-plan/v1");
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
  assert.equal(plan.capabilities?.domWrite, true);
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
    "https://ga.jspm.io/npm:nanoid@5",
  );
  assert.ok(plan.metadata?.tags?.includes("source-module"));
});

test("codegen recognizes fenced typescript alias and infers tsx", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    "```typescript",
    "import { useState } from 'react';",
    "export default function Counter() {",
    "  const [count, setCount] = useState(0);",
    "  return <button onClick={() => setCount(count + 1)}>{count}</button>;",
    "}",
    "```",
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "typescript source",
    llmText,
  });

  assert.equal(plan.source?.language, "tsx");
  assert.equal(plan.source?.runtime, "preact");
  assert.match(plan.source?.code ?? "", /useState/);
  assert.ok(plan.imports?.includes("react"));
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
    "https://ga.jspm.io/npm:nanoid@5",
  );
});

test("codegen merges imports from source and capabilities when payload imports are incomplete", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_import_merge_plan",
    version: 1,
    imports: [],
    capabilities: {
      domWrite: true,
      allowedModules: ["preact"],
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "import merge" }],
    },
    source: {
      language: "jsx",
      code: [
        "import { h } from 'preact';",
        "import { useState } from 'preact/hooks';",
        "export default function App() {",
        "  const [count, setCount] = useState(0);",
        "  return <button onClick={() => setCount(count + 1)}>{count}</button>;",
        "}",
      ].join("\n"),
      exportName: "default",
      runtime: "preact",
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "merge imports",
    llmText: planJson,
  });

  assert.deepEqual(plan.imports, ["preact", "preact/hooks"]);
  assert.equal(
    plan.moduleManifest?.preact?.resolvedUrl,
    "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  );
  assert.equal(
    plan.moduleManifest?.["preact/hooks"]?.resolvedUrl,
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
  );
});

test("codegen rewrites inline source component root module aliases", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "runtime-plan/v1",
    id: "inline_root_alias_plan",
    version: 1,
    root: {
      type: "component",
      module: "main",
      exportName: "default",
    },
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "jsx",
      runtime: "preact",
      code: "export default function App(){ return <section>ok</section>; }",
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "inline source alias",
    llmText: planJson,
  });

  assert.equal(plan.root.type, "element");
  assert.equal(plan.source?.language, "jsx");
  assert.ok(!(plan.imports ?? []).includes("main"));
});

test("codegen sanitizes synthetic source aliases and normalizes preact-style source runtime", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "runtime-plan/v1",
    id: "gemini_todo_source_plan",
    version: 1,
    root: {
      type: "component",
      module: "this-plan-source",
      exportName: "TodoApp",
      props: {},
    },
    imports: ["renderify", "this-plan-source"],
    moduleManifest: {
      renderify: {
        resolvedUrl:
          "https://cdn.renderify.dev/renderify@1.0.0/dist/renderify.js",
        signer: "renderify-codegen",
      },
      "this-plan-source": {
        resolvedUrl: "https://ga.jspm.io/npm:this-plan-source",
        signer: "renderify-codegen",
      },
    },
    capabilities: {
      domWrite: true,
      allowedModules: ["renderify", "this-plan-source"],
    },
    source: {
      language: "jsx",
      runtime: "renderify",
      exportName: "TodoApp",
      code: [
        "import { useState } from 'renderify';",
        "export function TodoApp() {",
        "  const [todos, setTodos] = useState([]);",
        "  return <section>{todos.length}</section>;",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.root.type, "element");
  assert.equal(plan.source?.runtime, "preact");
  assert.match(plan.source?.code ?? "", /from 'preact\/compat'/);
  assert.ok(!(plan.imports ?? []).includes("this-plan-source"));
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes("this-plan-source"),
  );
  assert.ok(!(plan.imports ?? []).includes("renderify"));
  assert.ok(!(plan.capabilities?.allowedModules ?? []).includes("renderify"));
  assert.equal(plan.moduleManifest?.["this-plan-source"], undefined);
  assert.equal(plan.moduleManifest?.renderify, undefined);
  assert.ok((plan.imports ?? []).includes("preact/compat"));
  assert.equal(
    plan.moduleManifest?.["preact/compat"]?.resolvedUrl,
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  );
});

test("codegen backfills moduleManifest and allowedModules when payload metadata is incomplete", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "manifest_backfill_plan",
    version: 1,
    imports: [],
    capabilities: {
      domWrite: true,
      allowedModules: [],
    },
    moduleManifest: {
      react: {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
        signer: "renderify-codegen",
      },
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "manifest backfill" }],
    },
    source: {
      language: "jsx",
      code: [
        "import { h } from 'preact';",
        "export default function App() {",
        "  return <section>ok</section>;",
        "}",
      ].join("\n"),
      exportName: "default",
      runtime: "preact",
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "manifest backfill",
    llmText: planJson,
  });

  assert.ok(plan.imports?.includes("preact"));
  assert.ok(plan.capabilities);
  assert.ok(plan.capabilities.allowedModules?.includes("preact"));
  assert.equal(
    plan.moduleManifest?.preact?.resolvedUrl,
    "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  );

  const checker = new DefaultSecurityChecker();
  checker.initialize();
  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true);
});

test("codegen incremental session streams source plans before finalization", async () => {
  const codegen = new DefaultCodeGenerator();
  const session = codegen.createIncrementalSession({
    prompt: "stream source plan",
  });

  const chunks = [
    '```tsx\nimport { nanoid } from "npm:nanoid@5";\n',
    "export default () => <section>{nanoid(4)}</section>;\n",
    "```",
  ];

  let lastUpdate: Awaited<ReturnType<typeof session.pushDelta>> | undefined;
  for (const chunk of chunks) {
    lastUpdate = await session.pushDelta(chunk);
  }

  assert.ok(lastUpdate);
  assert.equal(lastUpdate?.mode, "runtime-source");
  assert.equal(lastUpdate?.complete, true);
  assert.equal(lastUpdate?.plan.source?.runtime, "preact");
});

test("codegen incremental session emits fallback plans for plain text", async () => {
  const codegen = new DefaultCodeGenerator();
  const session = codegen.createIncrementalSession({
    prompt: "plain text",
  });

  const update = await session.pushDelta("hello incremental runtime");
  assert.ok(update);
  assert.equal(update?.mode, "runtime-text-fallback");
  assert.equal(update?.plan.root.type, "element");
  assert.equal(update?.complete, false);
});

test("codegen incremental session suppresses duplicate plan updates", async () => {
  const codegen = new DefaultCodeGenerator();
  const session = codegen.createIncrementalSession({
    prompt: "duplicate runtime plan",
  });

  const runtimePlanJson = JSON.stringify({
    id: "dup-plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "same plan" }],
    },
  });

  const firstUpdate = await session.pushDelta(runtimePlanJson);
  const secondUpdate = await session.pushDelta("\n\n");

  assert.ok(firstUpdate);
  assert.equal(firstUpdate?.mode, "runtime-plan-json");
  assert.equal(secondUpdate, undefined);
});
