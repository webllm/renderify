import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultCodeGenerator,
  isCodegenTextFallbackPlan,
} from "../packages/core/src/codegen";
import { DefaultRuntimeManager } from "../packages/runtime/src";
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

test("codegen normalizes DOM-like RuntimePlan JSON without text fallback", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "service status",
    llmText: JSON.stringify({
      specVersion: "runtime-plan/v1",
      id: "dom_like_plan",
      version: 1,
      root: {
        type: "div",
        props: { style: { color: "#16a34a" } },
        children: [
          { type: "span", children: ["Healthy"] },
          "RENDERIFY_SPARK_OK",
        ],
      },
      capabilities: { domWrite: true },
    }),
  });

  assert.equal(plan.id, "dom_like_plan");
  assert.equal(plan.root.type, "element");
  if (plan.root.type !== "element") {
    throw new Error("expected normalized element root");
  }
  assert.equal(plan.root.tag, "div");
  assert.deepEqual(plan.root.children?.[0], {
    type: "element",
    tag: "span",
    children: [{ type: "text", value: "Healthy" }],
  });
});

test("codegen normalizes aliases on a structurally valid RuntimePlan root", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "hybrid runtime node",
    llmText: JSON.stringify({
      id: "hybrid_alias_plan",
      version: 1,
      root: {
        type: "element",
        tag: "div",
        style: { color: "red" },
        nodes: [{ type: "text", value: "preserved child" }],
      },
    }),
  });

  assert.deepEqual(plan.root, {
    type: "element",
    tag: "div",
    props: { style: { color: "red" } },
    children: [{ type: "text", value: "preserved child" }],
  });
});

test("codegen skips candidates with both children and nodes", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject ambiguous child aliases",
    llmText: [
      JSON.stringify({
        id: "ambiguous_children_plan",
        version: 1,
        root: {
          type: "element",
          tag: "main",
          children: [],
          nodes: [{ type: "text", value: "must not be discarded" }],
        },
      }),
      JSON.stringify({
        id: "valid_after_ambiguous_children",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_ambiguous_children");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips candidates with both root and legacy nodes", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject ambiguous root aliases",
    llmText: [
      JSON.stringify({
        id: "ambiguous_root_plan",
        version: 1,
        root: { type: "text", value: "runtime content" },
        nodes: [{ type: "text", value: "legacy content" }],
      }),
      JSON.stringify({
        id: "valid_after_ambiguous_root",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_ambiguous_root");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips candidates with explicitly invalid tags", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject invalid explicit tags",
    llmText: [
      JSON.stringify({
        id: "invalid_inferred_tag_plan",
        version: 1,
        root: { type: "div", tag: 42 },
      }),
      JSON.stringify({
        id: "invalid_container_tag_plan",
        version: 1,
        root: { type: "container", tag: null },
      }),
      JSON.stringify({
        id: "valid_after_invalid_tags",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_invalid_tags");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips candidates with incoherent tag discriminators", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject incoherent tag discriminators",
    llmText: [
      JSON.stringify({
        id: "invalid_string_discriminator_plan",
        version: 1,
        root: { type: "NOT A TAG", tag: "div" },
      }),
      JSON.stringify({
        id: "conflicting_tag_discriminator_plan",
        version: 1,
        root: { type: "section", tag: "div" },
      }),
      JSON.stringify({
        id: "valid_after_incoherent_discriminators",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_incoherent_discriminators");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips candidates with invalid text node aliases", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject invalid text node aliases",
    llmText: [
      JSON.stringify({
        id: "styled_text_plan",
        version: 1,
        root: { type: "text", value: "content", style: { color: "red" } },
      }),
      JSON.stringify({
        id: "conflicting_text_alias_plan",
        version: 1,
        root: { type: "text", value: "canonical", text: "legacy" },
      }),
      JSON.stringify({
        id: "text_alias_on_element_plan",
        version: 1,
        root: { type: "element", tag: "div", text: "discarded" },
      }),
      JSON.stringify({
        id: "valid_after_invalid_text_aliases",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_invalid_text_aliases");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen preserves string style aliases and skips invalid ones", async () => {
  const codegen = new DefaultCodeGenerator();
  const styledPlan = await codegen.generatePlan({
    prompt: "string style alias",
    llmText: JSON.stringify({
      id: "string_style_alias_plan",
      version: 1,
      root: {
        type: "element",
        tag: "div",
        style: "color:red",
      },
    }),
  });
  assert.deepEqual(styledPlan.root, {
    type: "element",
    tag: "div",
    props: { style: "color:red" },
    children: [],
  });

  const repairedPlan = await codegen.generatePlan({
    prompt: "skip invalid style alias",
    llmText: [
      JSON.stringify({
        id: "invalid_style_alias_plan",
        version: 1,
        root: { type: "div", style: ["color:red"] },
      }),
      JSON.stringify({
        id: "valid_after_style_alias",
        version: 1,
        root: { type: "text", value: "valid plan" },
      }),
    ].join("\n"),
  });
  assert.equal(repairedPlan.id, "valid_after_style_alias");
});

test("codegen skips candidates with malformed DOM attribute aliases", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "skip invalid DOM aliases",
    llmText: [
      JSON.stringify({
        id: "invalid_class_name_alias_plan",
        version: 1,
        root: { type: "div", className: ["hero"] },
      }),
      JSON.stringify({
        id: "invalid_id_alias_plan",
        version: 1,
        root: { type: "div", id: null },
      }),
      JSON.stringify({
        id: "invalid_html_for_alias_plan",
        version: 1,
        root: { type: "label", htmlFor: ["email"] },
      }),
      JSON.stringify({
        id: "valid_after_invalid_dom_aliases",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_invalid_dom_aliases");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
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

test("codegen extracts RuntimePlan JSON from prose-wrapped output", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    "Sure, here is the RuntimePlan JSON:",
    "",
    '{"id":"wrapped_json_plan","version":1,"capabilities":{"domWrite":true},"root":{"type":"element","tag":"section","children":[{"type":"text","value":"wrapped"}]}}',
    "",
    "Use it directly.",
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "wrapped json",
    llmText,
  });

  assert.equal(plan.id, "wrapped_json_plan");
  assert.equal(plan.root.type, "element");
  if (plan.root.type !== "element") {
    throw new Error("expected wrapped_json_plan root to be element");
  }
  assert.equal(plan.root.tag, "section");
});

test("codegen skips unrelated JSON before the RuntimePlan payload", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    'Analysis metadata: {"confidence":0.92}',
    "```json",
    '{"note":"this fenced object is not a plan"}',
    "```",
    "Final RuntimePlan:",
    '{"id":"later_runtime_plan","version":1,"root":{"type":"text","value":"selected later payload"}}',
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "select the actual plan",
    llmText,
  });

  assert.equal(plan.id, "later_runtime_plan");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected later payload",
  });
});

test("codegen skips weakly marked metadata before a RuntimePlan", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    'Primitive metadata: {"root":"not a plan"}',
    'Object metadata: {"root":{"type":"div","children":["also not a plan"]}}',
    'ID metadata: {"id":"metadata_record","root":{"type":"div","children":["wrong id candidate"]}}',
    'Version metadata: {"version":1,"root":{"type":"div","children":["wrong version candidate"]}}',
    'Capabilities metadata: {"capabilities":{"domWrite":true},"root":{"type":"div","children":["wrong capabilities candidate"]}}',
    'Legacy ID metadata: {"id":"legacy_metadata_record","nodes":["wrong legacy id candidate"]}',
    'Legacy version metadata: {"version":1,"nodes":["wrong legacy version candidate"]}',
    'Legacy capabilities metadata: {"capabilities":{"domWrite":true},"nodes":["wrong legacy capabilities candidate"]}',
    "Final RuntimePlan:",
    '{"id":"primitive_root_real_plan","version":1,"root":{"type":"text","value":"selected real plan"}}',
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "ignore metadata roots",
    llmText,
  });

  assert.equal(plan.id, "primitive_root_real_plan");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected real plan",
  });
});

test("codegen skips a RuntimePlan candidate with malformed node props", async () => {
  const codegen = new DefaultCodeGenerator();
  const llmText = [
    "Invalid RuntimePlan:",
    '{"id":"invalid_props_plan","version":1,"root":{"type":"div","props":["not","an","object"],"children":["wrong candidate"]}}',
    "Corrected RuntimePlan:",
    '{"id":"repaired_props_plan","version":1,"root":{"type":"text","value":"selected corrected plan"}}',
  ].join("\n");

  const plan = await codegen.generatePlan({
    prompt: "select the valid plan",
    llmText,
  });

  assert.equal(plan.id, "repaired_props_plan");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected corrected plan",
  });
});

test("codegen skips candidates with explicit invalid node discriminators", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject invalid node discriminators",
    llmText: [
      JSON.stringify({
        id: "invalid_numeric_type_plan",
        version: 1,
        root: { type: 42, tag: "div", children: ["must not render"] },
      }),
      JSON.stringify({
        id: "invalid_text_value_plan",
        version: 1,
        root: {
          type: "text",
          value: 42,
          text: "must not replace invalid value",
        },
      }),
      JSON.stringify({
        id: "valid_after_invalid_discriminators",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_invalid_discriminators");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips a legacy candidate with an explicit null root", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject null root",
    llmText: [
      JSON.stringify({
        id: "null_root_candidate",
        version: 1,
        root: null,
        nodes: ["must not be selected"],
      }),
      JSON.stringify({
        id: "valid_after_null_root",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_null_root");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
});

test("codegen skips candidates with conflicting spec version aliases", async () => {
  const codegen = new DefaultCodeGenerator();
  const plan = await codegen.generatePlan({
    prompt: "reject conflicting spec aliases",
    llmText: [
      JSON.stringify({
        id: "conflicting_spec_alias_plan",
        version: "runtime-plan/v1",
        specVersion: "runtime-plan/v2",
        root: { type: "text", value: "must not render" },
      }),
      JSON.stringify({
        id: "valid_after_conflicting_spec_alias",
        version: 1,
        root: { type: "text", value: "selected valid plan" },
      }),
    ].join("\n"),
  });

  assert.equal(plan.id, "valid_after_conflicting_spec_alias");
  assert.deepEqual(plan.root, {
    type: "text",
    value: "selected valid plan",
  });
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
  assert.equal(isCodegenTextFallbackPlan(plan), true);
});

test("codegen assigns unique fallback plan ids and isolates runtime state when the clock does not advance", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    version: 1,
    root: {
      type: "element",
      tag: "p",
      children: [{ type: "text", value: "Count={{state.count}}" }],
    },
    state: {
      initial: { count: 0 },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  });
  const originalNow = Date.now;
  let plans: Awaited<ReturnType<DefaultCodeGenerator["generatePlan"]>>[] = [];

  Date.now = () => 1_700_000_000_000;
  try {
    plans = await Promise.all(
      Array.from({ length: 32 }, () =>
        codegen.generatePlan({
          prompt: "stateful counter",
          llmText: planJson,
        }),
      ),
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
  assert.ok(plans.every((plan) => plan.id.startsWith("plan_")));

  const [firstPlan, secondPlan] = plans;
  assert.ok(firstPlan);
  assert.ok(secondPlan);

  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();
  try {
    const firstResult = await runtime.executePlan(firstPlan, undefined, {
      type: "increment",
    });
    const secondResult = await runtime.executePlan(secondPlan);

    assert.equal(firstResult.state?.count, 1);
    assert.equal(secondResult.state?.count, 0);
    assert.equal(runtime.getPlanState(firstPlan.id)?.count, 1);
    assert.equal(runtime.getPlanState(secondPlan.id)?.count, 0);
  } finally {
    await runtime.terminate();
  }
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

test("codegen keeps source plan when RuntimePlan root is invalid but source exists", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_invalid_root_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "component",
      exportName: "TodoApp",
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "TodoApp",
      code: [
        "import { useState } from 'preact/hooks';",
        "export function TodoApp() {",
        "  const [todos] = useState<string[]>([]);",
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
  if (plan.root.type !== "element") {
    throw new Error("expected source fallback root to be element");
  }
  assert.equal(plan.root.props?.class, "renderify-runtime-source-plan");
  assert.equal(plan.source?.language, "tsx");
  assert.ok((plan.imports ?? []).includes("preact/hooks"));
});

test("codegen skips source-backed candidates with malformed explicit roots", async () => {
  const codegen = new DefaultCodeGenerator();
  const source = {
    language: "tsx",
    runtime: "preact",
    code: "export default () => <main>invalid root</main>",
  };
  const invalidCandidates = [
    { id: "numeric_root", version: 1, root: 42, source },
    { id: "array_root", version: 1, root: [], source },
    {
      id: "invalid_element_root",
      version: 1,
      root: { type: "element" },
      source,
    },
    {
      id: "invalid_component_module",
      version: 1,
      root: { type: "component", module: 42 },
      source,
    },
  ];
  const validPlan = {
    id: "valid_after_invalid_roots",
    version: 1,
    root: { type: "text", value: "selected valid plan" },
  };

  const plan = await codegen.generatePlan({
    prompt: "skip malformed explicit roots",
    llmText: [...invalidCandidates, validPlan]
      .map((candidate) => JSON.stringify(candidate))
      .join("\n"),
  });

  assert.equal(plan.id, validPlan.id);
  assert.deepEqual(plan.root, validPlan.root);
  assert.equal(plan.source, undefined);
});

test("codegen skips source-backed candidates with invalid semantic fields", async () => {
  const codegen = new DefaultCodeGenerator();
  const source = {
    language: "tsx",
    runtime: "preact",
    code: "export default () => <main>invalid candidate</main>",
  };
  const baseCandidate = {
    id: "invalid_source_candidate",
    version: 1,
    capabilities: { domWrite: true },
    root: { type: "component", exportName: "default" },
    source,
  };
  const invalidCandidates = [
    { ...baseCandidate, id: "" },
    { ...baseCandidate, version: 0 },
    { ...baseCandidate, specVersion: "" },
    { ...baseCandidate, capabilities: { domWrite: "yes" } },
    { ...baseCandidate, imports: ["preact", 42] },
    {
      ...baseCandidate,
      moduleManifest: { preact: { resolvedUrl: "" } },
    },
    { ...baseCandidate, state: { initial: [] } },
    { ...baseCandidate, metadata: { tags: [42] } },
  ];
  const validPlan = {
    id: "later_valid_plan",
    version: 1,
    root: { type: "text", value: "selected valid plan" },
  };

  const plan = await codegen.generatePlan({
    prompt: "skip invalid source-backed candidates",
    llmText: [...invalidCandidates, validPlan]
      .map((candidate) => JSON.stringify(candidate))
      .join("\n"),
  });

  assert.equal(plan.id, "later_valid_plan");
  assert.deepEqual(plan.root, validPlan.root);
  assert.equal(plan.source, undefined);
});

test("codegen repairs compact JSX attribute spacing in source code", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_compact_jsx_spacing_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "compact spacing" }],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "default",
      code: [
        "import { useState } from 'preact/hooks';",
        "export default function TodoApp() {",
        "  const [value, setValue] = useState('');",
        "  const [checked, setChecked] = useState(false);",
        '  return (<div><inputtype="text"value={value}onInput={(e) => setValue((e.target as HTMLInputElement).value)}/><inputtype="checkbox"checked={checked}onInput={() => setChecked(!checked)}/></div>);',
        "}",
      ].join(""),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.match(
    plan.source?.code ?? "",
    /<input type="text" value=\{value\} onInput=/,
  );
  assert.match(
    plan.source?.code ?? "",
    /<input type="checkbox" checked=\{checked\} onInput=/,
  );
});

test("codegen does not apply source repair regexes to valid literals", async () => {
  const codegen = new DefaultCodeGenerator();
  const sourceCode = [
    'const compactMarkup = \'<inputtype="text"value="literal">\';',
    "const closingBracePattern = /}/;",
    "export default function LiteralDemo() {",
    "  return <pre>{compactMarkup}:{closingBracePattern.source}</pre>;",
    "}",
  ].join("\n");
  const planJson = JSON.stringify({
    id: "source_valid_literals_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "literal preservation" }],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "default",
      code: sourceCode,
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "preserve valid source literals",
    llmText: planJson,
  });

  assert.equal(plan.source?.code, sourceCode);
});

test("codegen infers source exportName from named exports when default export is absent", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_named_export_infer_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "named export infer" }],
    },
    source: {
      language: "jsx",
      runtime: "preact",
      code: [
        "import { useState } from 'preact/hooks';",
        "export function TodoApp() {",
        "  const [todos] = useState([]);",
        "  return <section>{todos.length}</section>;",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.source?.exportName, "TodoApp");
});

test("codegen rewrites invalid source exportName to default when default export exists", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_export_default_rewrite_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "default export rewrite" }],
    },
    source: {
      language: "jsx",
      runtime: "preact",
      exportName: "TodoApp",
      code: [
        "import { useState } from 'preact/hooks';",
        "export default function App() {",
        "  const [todos] = useState([]);",
        "  return <section>{todos.length}</section>;",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.source?.exportName, "default");
});

test("codegen adds default export when source has no exports but defines a component", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_missing_export_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "missing export" }],
    },
    source: {
      language: "jsx",
      runtime: "preact",
      code: [
        "function TodoApp() {",
        "  return <section>ok</section>;",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.source?.exportName, "default");
  assert.match(plan.source?.code ?? "", /\bexport default TodoApp;/);
});

test("codegen strips unmatched closing braces from source code", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_unmatched_brace_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "brace cleanup" }],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "TodoApp",
      code: [
        "export function TodoApp() {",
        "  return <section>ok</section>;",
        "}}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.doesNotMatch(plan.source?.code ?? "", /\}\}$/);
});

test("codegen falls back to builtin todo source template when todo source is syntactically invalid", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_invalid_todo_template_fallback_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "component",
      module: "this-plan-source",
      exportName: "TodoApp",
      props: {},
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "TodoApp",
      code: [
        "import { useState } from 'preact/hooks';",
        "export function TodoApp() {",
        "  const [todos, setTodos] = useState([]);",
        '  return (<div><input type="text" value={"x"} /></div>;',
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.source?.exportName, "default");
  assert.match(plan.source?.code ?? "", /Add Todo/);
  assert.equal(plan.metadata?.sourceFallback, "todo-template");
});

test("codegen rewrites shadcn alias source imports to portable local components", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_shadcn_alias_rewrite_plan",
    version: 1,
    imports: [
      "preact/hooks",
      "https://esm.sh/@/components/ui/button",
      "https://esm.sh/@/components/ui/input",
      "https://esm.sh/*",
    ],
    capabilities: {
      domWrite: true,
      allowedModules: [
        "preact/hooks",
        "https://esm.sh/@/components/ui/button",
        "https://esm.sh/*",
      ],
    },
    moduleManifest: {
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
      },
      "https://esm.sh/@/components/ui/button": {
        resolvedUrl: "https://esm.sh/@/components/ui/button",
      },
      "https://esm.sh/*": {
        resolvedUrl: "https://esm.sh/*",
      },
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "shadcn alias rewrite" }],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "default",
      code: [
        "import { useState } from 'preact/hooks';",
        "import { Button } from 'https://esm.sh/@/components/ui/button';",
        "import { Input } from 'https://esm.sh/@/components/ui/input';",
        "export default function TodoApp() {",
        "  const [value, setValue] = useState('');",
        "  return (<div><Input value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} /><Button>Add</Button></div>);",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app with shadcn",
    llmText: planJson,
  });

  assert.match(plan.source?.code ?? "", /__renderifyShadcnCompat/);
  assert.doesNotMatch(
    plan.source?.code ?? "",
    /https:\/\/esm\.sh\/@\/components\/ui\//,
  );
  assert.ok((plan.imports ?? []).includes("preact/hooks"));
  assert.ok(
    !(plan.imports ?? []).includes("https://esm.sh/@/components/ui/button"),
  );
  assert.ok(!(plan.imports ?? []).includes("https://esm.sh/*"));
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes(
      "https://esm.sh/@/components/ui/button",
    ),
  );
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes("https://esm.sh/*"),
  );
  assert.equal(
    plan.moduleManifest?.["https://esm.sh/@/components/ui/button"],
    undefined,
  );
  assert.equal(plan.moduleManifest?.["https://esm.sh/*"], undefined);
});

test("codegen canonicalizes material ui imports to bare npm specifiers", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_material_ui_rewrite_plan",
    version: 1,
    imports: [
      "preact/hooks",
      "@mui/material",
      "@mui/icons-material/Delete",
      "https://esm.sh/@mui/material@5.15.0",
      "https://esm.sh/@mui/icons-material@5.15.0",
    ],
    capabilities: {
      domWrite: true,
      allowedModules: [
        "preact/hooks",
        "@mui/material",
        "@mui/icons-material/Delete",
        "https://esm.sh/@mui/material@5.15.0",
      ],
    },
    moduleManifest: {
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
      },
      "@mui/material": {
        resolvedUrl: "https://esm.sh/@mui/material@5.15.0",
      },
      "@mui/icons-material/Delete": {
        resolvedUrl: "https://esm.sh/@mui/icons-material@5.15.0/Delete",
      },
      "https://esm.sh/@mui/material@5.15.0": {
        resolvedUrl: "https://esm.sh/@mui/material@5.15.0",
      },
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "material ui rewrite" }],
    },
    source: {
      language: "jsx",
      runtime: "preact",
      exportName: "default",
      code: [
        "import { useState } from 'preact/hooks';",
        "import { Box, TextField, Button } from 'https://esm.sh/@mui/material@5.15.0';",
        "import DeleteIcon from 'https://esm.sh/@mui/icons-material@5.15.0/Delete';",
        "export default function TodoApp() {",
        "  const [value, setValue] = useState('');",
        "  return (<Box><TextField value={value} onChange={(e) => setValue(e.target.value)} /><Button><DeleteIcon />Add</Button></Box>);",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app with material ui",
    llmText: planJson,
  });

  assert.match(plan.source?.code ?? "", /from '@mui\/material@5\.15\.0'/);
  assert.match(
    plan.source?.code ?? "",
    /from '@mui\/icons-material@5\.15\.0\/Delete'/,
  );
  assert.doesNotMatch(plan.source?.code ?? "", /https:\/\/esm\.sh\/@mui\//);
  assert.ok((plan.imports ?? []).includes("preact/hooks"));
  assert.ok((plan.imports ?? []).includes("@mui/material"));
  assert.ok((plan.imports ?? []).includes("@mui/icons-material/Delete"));
  assert.ok((plan.imports ?? []).includes("@mui/material@5.15.0"));
  assert.ok((plan.imports ?? []).includes("@mui/icons-material@5.15.0/Delete"));
  assert.ok(
    !(plan.imports ?? []).includes("https://esm.sh/@mui/material@5.15.0"),
  );
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes(
      "https://esm.sh/@mui/material@5.15.0",
    ),
  );
  assert.equal(
    plan.moduleManifest?.["https://esm.sh/@mui/material@5.15.0"],
    undefined,
  );
  assert.equal(
    plan.moduleManifest?.["@mui/material"]?.resolvedUrl,
    "@mui/material@5.15.0",
  );
  assert.equal(
    plan.moduleManifest?.["@mui/icons-material/Delete"]?.resolvedUrl,
    "@mui/icons-material@5.15.0/Delete",
  );
});

test("codegen falls back to todo template when todo source imports unsupported wildcard module specifier", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    id: "source_unsupported_wildcard_import_plan",
    version: 1,
    capabilities: {
      domWrite: true,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "unsupported wildcard import" }],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "default",
      code: [
        "import { useState } from 'preact/hooks';",
        "import ghost from 'https://esm.sh/*';",
        "export default function TodoApp() {",
        "  const [todos] = useState<string[]>([]);",
        "  return <section>{todos.length}</section>;",
        "}",
      ].join("\n"),
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app",
    llmText: planJson,
  });

  assert.equal(plan.metadata?.sourceFallback, "todo-template");
  assert.match(plan.source?.code ?? "", /Add Todo/);
  assert.ok(!(plan.imports ?? []).includes("https://esm.sh/*"));
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

test("codegen treats source component module alias as synthetic source reference", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "runtime-plan/v1",
    id: "source_component_alias_plan",
    version: 1,
    root: {
      type: "component",
      module: "todo-app-module",
      exportName: "TodoApp",
      props: {},
    },
    imports: ["todo-app-module", "preact/hooks"],
    moduleManifest: {
      "todo-app-module": {
        resolvedUrl: "https://ga.jspm.io/npm:todo-app-module",
        signer: "renderify-codegen",
      },
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.mjs",
        signer: "renderify-codegen",
      },
    },
    capabilities: {
      domWrite: true,
      allowedModules: ["todo-app-module", "preact/hooks"],
    },
    source: {
      language: "tsx",
      runtime: "preact",
      exportName: "TodoApp",
      code: [
        "import { useState } from 'preact/hooks';",
        "export function TodoApp() {",
        "  const [todos, setTodos] = useState<string[]>([]);",
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
  assert.ok(!(plan.imports ?? []).includes("todo-app-module"));
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes("todo-app-module"),
  );
  assert.equal(plan.moduleManifest?.["todo-app-module"], undefined);
  assert.ok((plan.imports ?? []).includes("preact/hooks"));
  assert.equal(
    plan.moduleManifest?.["preact/hooks"]?.resolvedUrl,
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.mjs",
  );
});

test("codegen recovers todo fallback when source alias component is missing source module", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "runtime-plan/v1",
    id: "todo_alias_missing_source",
    version: 1,
    root: {
      type: "component",
      module: "source",
      exportName: "default",
    },
    imports: ["source", "preact/hooks"],
    capabilities: {
      domWrite: true,
      allowedModules: ["source", "preact/hooks"],
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "create todo app with material ui",
    llmText: planJson,
  });

  assert.equal(plan.root.type, "element");
  assert.equal(plan.source?.runtime, "preact");
  assert.match(plan.source?.code ?? "", /export default function TodoApp/);
  assert.ok(!(plan.imports ?? []).includes("source"));
  assert.ok(!(plan.capabilities?.allowedModules ?? []).includes("source"));
  assert.equal(plan.moduleManifest?.source, undefined);
  assert.equal(plan.metadata?.sourceFallback, "todo-template");
});

test("codegen recovers text fallback when source alias component is missing source module for non-todo prompts", async () => {
  const codegen = new DefaultCodeGenerator();
  const planJson = JSON.stringify({
    specVersion: "runtime-plan/v1",
    id: "alias_missing_source_non_todo",
    version: 1,
    root: {
      type: "component",
      module: "source",
      exportName: "default",
    },
    imports: ["source"],
    capabilities: {
      domWrite: true,
      allowedModules: ["source"],
    },
  });

  const plan = await codegen.generatePlan({
    prompt: "build analytics dashboard",
    llmText: planJson,
  });

  assert.equal(plan.root.type, "element");
  assert.equal(plan.source, undefined);
  assert.ok(!(plan.imports ?? []).includes("source"));
  assert.ok(!(plan.capabilities?.allowedModules ?? []).includes("source"));
  assert.equal(plan.moduleManifest?.source, undefined);
  assert.equal(plan.metadata?.sourceFallback, "missing-source-module");
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
  checker.initialize({ profile: "relaxed" });
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
  assert.equal(update.mode, "runtime-text-fallback");
  assert.equal(update.plan.root.type, "element");
  assert.equal(update.complete, false);
  assert.equal(isCodegenTextFallbackPlan(update.plan), true);
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
