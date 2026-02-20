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

test("codegen rewrites material ui source imports to portable local components", async () => {
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
        "import { Box, TextField, Button } from '@mui/material';",
        "import DeleteIcon from '@mui/icons-material/Delete';",
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

  assert.match(plan.source?.code ?? "", /__renderifyMuiCompat/);
  assert.match(plan.source?.code ?? "", /__renderifyMuiIcons/);
  assert.doesNotMatch(plan.source?.code ?? "", /@mui\/material/);
  assert.doesNotMatch(plan.source?.code ?? "", /@mui\/icons-material/);
  assert.ok((plan.imports ?? []).includes("preact/hooks"));
  assert.ok(!(plan.imports ?? []).includes("@mui/material"));
  assert.ok(!(plan.imports ?? []).includes("@mui/icons-material/Delete"));
  assert.ok(
    !(plan.imports ?? []).includes("https://esm.sh/@mui/material@5.15.0"),
  );
  assert.ok(
    !(plan.capabilities?.allowedModules ?? []).includes("@mui/material"),
  );
  assert.equal(plan.moduleManifest?.["@mui/material"], undefined);
  assert.equal(plan.moduleManifest?.["@mui/icons-material/Delete"], undefined);
  assert.equal(
    plan.moduleManifest?.["https://esm.sh/@mui/material@5.15.0"],
    undefined,
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
