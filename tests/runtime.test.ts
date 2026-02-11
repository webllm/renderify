import assert from "node:assert/strict";
import test from "node:test";
import {
  createComponentNode,
  createElementNode,
  createTextNode,
  type RuntimeNode,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  DefaultRuntimeManager,
  type RuntimeComponentFactory,
  type RuntimeModuleLoader,
  type RuntimeSourceTranspileInput,
  type RuntimeSourceTranspiler,
} from "../packages/runtime/src/index";

class MockLoader implements RuntimeModuleLoader {
  constructor(private readonly modules: Record<string, unknown>) {}

  async load(specifier: string): Promise<unknown> {
    if (!(specifier in this.modules)) {
      throw new Error(`missing module: ${specifier}`);
    }
    return this.modules[specifier];
  }
}

class PassthroughSourceTranspiler implements RuntimeSourceTranspiler {
  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    return input.code;
  }
}

class ResolveOnlyLoader implements RuntimeModuleLoader {
  async load(_specifier: string): Promise<unknown> {
    return {};
  }

  resolveSpecifier(specifier: string): string {
    if (specifier === "virtual:msg") {
      return `data:text/javascript,${encodeURIComponent(
        "export default 'from-jspm-resolver';"
      )}`;
    }

    return specifier;
  }
}

function createPlan(root: RuntimeNode, imports: string[] = []): RuntimePlan {
  return {
    id: "runtime_test_plan",
    version: 1,
    root,
    imports,
    capabilities: {
      domWrite: true,
    },
  };
}

test("runtime resolves component nodes through module loader", async () => {
  const component: RuntimeComponentFactory = (props) => {
    return createElementNode("div", { class: "card" }, [
      createTextNode(String(props.title ?? "untitled")),
    ]);
  };

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/card": {
        default: component,
      },
    }),
  });

  await runtime.initialize();

  const plan = createPlan(createComponentNode("npm:acme/card", "default", {
    title: "Hello",
  }), ["npm:acme/card"]);

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }

  assert.equal(result.root.tag, "div");
  assert.equal(result.diagnostics.length, 0);

  await runtime.terminate();
});

test("runtime reports warning when no loader is configured", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan = createPlan(createComponentNode("npm:acme/card"), ["npm:acme/card"]);
  const result = await runtime.executePlan(plan);

  assert.ok(result.diagnostics.some((item) => item.code === "RUNTIME_LOADER_MISSING"));
  assert.ok(result.diagnostics.some((item) => item.code === "RUNTIME_COMPONENT_SKIPPED"));

  await runtime.terminate();
});

test("runtime applies event transitions and interpolates state/context values", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_stateful_plan",
    version: 1,
    root: createElementNode("p", undefined, [
      createTextNode("Count={{state.count}} Last={{state.last}} Actor={{state.actor}}"),
    ]),
    capabilities: {
      domWrite: true,
      maxExecutionMs: 500,
    },
    state: {
      initial: {
        count: 0,
        last: 0,
        actor: "",
      },
      transitions: {
        increment: [
          { type: "increment", path: "count", by: 1 },
          { type: "set", path: "last", value: { $from: "event.payload.delta" } },
          { type: "set", path: "actor", value: { $from: "context.userId" } },
        ],
      },
    },
  };

  const result = await runtime.executePlan(
    plan,
    {
      userId: "user_42",
    },
    {
      type: "increment",
      payload: {
        delta: 3,
      },
    }
  );

  assert.deepEqual(result.appliedActions?.map((item) => item.type), [
    "increment",
    "set",
    "set",
  ]);
  assert.equal(result.state?.count, 1);
  assert.equal(result.state?.last, 3);
  assert.equal(result.state?.actor, "user_42");
  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  const textNode = result.root.children?.[0];
  assert.equal(textNode?.type, "text");
  if (!textNode || textNode.type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(
    textNode.value,
    "Count=1 Last=3 Actor=user_42"
  );

  await runtime.terminate();
});

test("runtime enforces maxImports capability", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/first": { default: () => createTextNode("ok") },
      "npm:acme/second": { default: () => createTextNode("ok") },
    }),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_import_cap_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("hello")]),
    imports: ["npm:acme/first", "npm:acme/second"],
    capabilities: {
      domWrite: true,
      maxImports: 1,
    },
  };

  const result = await runtime.executePlan(plan);

  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_IMPORT_LIMIT_EXCEEDED"
    )
  );

  await runtime.terminate();
});

test("runtime supports isolated-vm execution profile for sync components", async () => {
  const isolatedComponent: RuntimeComponentFactory = (props) => ({
    type: "element",
    tag: "span",
    children: [{ type: "text", value: String(props.label ?? "iso") }],
  });

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/iso": {
        default: isolatedComponent,
      },
    }),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_isolated_profile_plan",
    version: 1,
    root: createComponentNode("npm:acme/iso", "default", {
      label: "isolated",
    }),
    imports: ["npm:acme/iso"],
    capabilities: {
      domWrite: true,
      executionProfile: "isolated-vm",
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.equal(result.root.tag, "span");
  assert.equal(result.diagnostics.length, 0);

  await runtime.terminate();
});

test("runtime isolated-vm profile rejects async component factories", async () => {
  const asyncComponent: RuntimeComponentFactory = async () => ({
    type: "text",
    value: "async",
  });

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/async-iso": {
        default: asyncComponent,
      },
    }),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_isolated_async_plan",
    version: 1,
    root: createComponentNode("npm:acme/async-iso"),
    imports: ["npm:acme/async-iso"],
    capabilities: {
      domWrite: true,
      executionProfile: "isolated-vm",
    },
  };

  const result = await runtime.executePlan(plan);

  assert.ok(
    result.diagnostics.some((item) => item.code === "RUNTIME_COMPONENT_EXEC_FAILED")
  );

  await runtime.terminate();
});

test("runtime executes source module export using custom transpiler", async () => {
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_source_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 7,
      },
    },
    source: {
      language: "js",
      code: [
        "export default ({ state }) => ({",
        '  type: "element",',
        '  tag: "p",',
        "  children: [{ type: 'text', value: `Count=${state.count}` }],",
        "});",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.equal(result.root.tag, "p");
  assert.equal(result.root.children?.[0]?.type, "text");
  if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(result.root.children[0].value, "Count=7");

  await runtime.terminate();
});

test("runtime rewrites source imports through module loader resolver", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new ResolveOnlyLoader(),
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    id: "runtime_source_import_rewrite_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      code: [
        'import msg from "virtual:msg";',
        "export default () => ({",
        '  type: "text",',
        "  value: msg,",
        "});",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "text");
  if (result.root.type !== "text") {
    throw new Error("expected text root");
  }
  assert.equal(result.root.value, "from-jspm-resolver");

  await runtime.terminate();
});
