import assert from "node:assert/strict";
import test from "node:test";
import {
  areRuntimeValuesEqual,
  collectRuntimePlanTemplateDiagnostics,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  diagnoseRuntimePlanCandidate,
  isRuntimeAction,
  isRuntimeNode,
  isRuntimePlan,
  isRuntimeTruthy,
  normalizeRuntimeNodeCandidate,
  normalizeRuntimePlanCandidate,
  RUNTIME_BIND_EVENT_TYPE,
  RUNTIME_PLAN_JSON_SCHEMA,
  type RuntimeElementNode,
  type RuntimeEvent,
  type RuntimeExecutionResult,
  type RuntimeNode,
  type RuntimePlan,
  removeValueByPath,
  resolveRuntimeEventReferences,
  resolveRuntimeStatePath,
  setValueByPath,
} from "../packages/ir/src/index";
import {
  DeclarativeMcpPlanError,
  parseDeclarativeMcpPlan,
} from "../packages/mcp-app/src/index";
import {
  DefaultRuntimeManager,
  DefaultUIRenderer,
} from "../packages/runtime/src/index";
import { DefaultSecurityChecker } from "../packages/security/src/index";

function createTodoPlan(): RuntimePlan {
  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "interaction_todos",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "section",
      children: [
        {
          type: "element",
          tag: "input",
          props: { bind: "draft", placeholder: "New task", onEnter: "add" },
        },
        {
          type: "element",
          tag: "button",
          props: { onClick: "add" },
          children: [{ type: "text", value: "Add" }],
        },
        {
          type: "if",
          when: "state.todos",
          not: true,
          children: [
            {
              type: "element",
              tag: "p",
              props: { class: "empty" },
              children: [{ type: "text", value: "Nothing to do" }],
            },
          ],
        },
        {
          type: "element",
          tag: "ul",
          children: [
            {
              type: "each",
              items: "state.todos",
              as: "todo",
              key: "id",
              children: [
                {
                  type: "element",
                  tag: "li",
                  children: [
                    {
                      type: "element",
                      tag: "input",
                      props: { type: "checkbox", bind: "todos.{{index}}.done" },
                    },
                    { type: "text", value: "{{index}}: {{todo.title}}" },
                    {
                      type: "if",
                      when: "todo.done",
                      children: [{ type: "text", value: " (done)" }],
                    },
                    {
                      type: "element",
                      tag: "button",
                      props: {
                        onClick: {
                          type: "remove",
                          payload: { index: "{{index}}" },
                        },
                      },
                      children: [{ type: "text", value: "Remove" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    state: {
      initial: {
        draft: "",
        nextId: 3,
        todos: [
          { id: 1, title: "Write docs", done: false },
          { id: 2, title: "Ship", done: true },
        ],
      },
      transitions: {
        add: [
          {
            type: "push",
            path: "todos",
            value: {
              id: { $from: "state.nextId" },
              title: { $from: "state.draft" },
              done: false,
            },
          },
          { type: "increment", path: "nextId" },
          { type: "set", path: "draft", value: "" },
        ],
        remove: [{ type: "remove", path: "todos.{{event.payload.index}}" }],
      },
    },
  };
}

function collectElements(node: RuntimeNode, tag: string): RuntimeElementNode[] {
  const found: RuntimeElementNode[] = [];
  const visit = (current: RuntimeNode) => {
    if (current.type === "element" && current.tag === tag) {
      found.push(current);
    }
    if (current.type !== "text") {
      for (const child of current.children ?? []) {
        visit(child);
      }
    }
  };
  visit(node);
  return found;
}

function textOf(node: RuntimeNode): string {
  if (node.type === "text") {
    return node.value;
  }
  return (node.children ?? []).map(textOf).join("");
}

function todosOf(
  result: RuntimeExecutionResult,
): Array<{ id: number; done: boolean }> {
  return (result.state?.todos ?? []) as Array<{ id: number; done: boolean }>;
}

async function createRuntime(): Promise<DefaultRuntimeManager> {
  const runtime = new DefaultRuntimeManager({
    enableDependencyPreflight: false,
  });
  await runtime.initialize();
  return runtime;
}

test("each and if are canonical RuntimePlan nodes", async () => {
  const plan = createTodoPlan();
  assert.equal(isRuntimePlan(plan), true);
  assert.deepEqual(normalizeRuntimePlanCandidate(plan), plan);
  assert.deepEqual(collectRuntimePlanTemplateDiagnostics(plan), []);
  assert.deepEqual(diagnoseRuntimePlanCandidate(plan), []);

  const checker = new DefaultSecurityChecker();
  checker.initialize();
  const security = await checker.checkPlan(plan);
  assert.deepEqual(security.issues, []);
  assert.equal(security.safe, true);
});

test("invalid control nodes are rejected with repair diagnostics", () => {
  const withRoot = (root: unknown) =>
    ({ ...createTodoPlan(), root }) as unknown as RuntimePlan;

  const cases: Array<{ node: unknown; message: RegExp }> = [
    {
      node: { type: "each", items: "state.todos", as: "state", children: [] },
      message: /root\.as must be a simple identifier/,
    },
    {
      node: { type: "each", items: "state.todos", as: "i", index: "i" },
      message: /root\.as and root\.index must be different names/,
    },
    {
      node: { type: "each", items: "state.__proto__", children: [] },
      message: /root\.items must reference an array/,
    },
    {
      node: { type: "each", items: "state.todos", props: { class: "x" } },
      message: /root\.props is not valid on a RuntimeNode/,
    },
    {
      node: { type: "if", when: "state.open", equals: { nested: true } },
      message: /root\.equals must be a string, number, boolean, or null/,
    },
    {
      node: { type: "if", children: [] },
      message: /root\.when must reference a value/,
    },
  ];

  for (const { node, message } of cases) {
    assert.equal(isRuntimeNode(node), false, JSON.stringify(node));
    const plan = withRoot(node);
    assert.equal(isRuntimePlan(plan), false, JSON.stringify(node));
    assert.match(diagnoseRuntimePlanCandidate(plan).join("\n"), message);
  }

  const badPath = createTodoPlan();
  badPath.state = {
    initial: { todos: [] },
    transitions: {
      remove: [{ type: "remove", path: "todos.item{{event.payload.index}}" }],
    },
  };
  assert.equal(isRuntimePlan(badPath), false);
  assert.match(
    diagnoseRuntimePlanCandidate(badPath).join("\n"),
    /state\.transitions\.remove\[0\]\.path templates must fill a whole segment/,
  );
});

test("normalization keeps control nodes and accepts legacy nodes arrays", () => {
  assert.deepEqual(
    normalizeRuntimeNodeCandidate({
      type: "each",
      items: "{{state.list}}",
      nodes: [{ type: "text", value: "{{item}}" }],
    }),
    {
      type: "each",
      items: "{{state.list}}",
      children: [{ type: "text", value: "{{item}}" }],
    },
  );
  assert.equal(
    normalizeRuntimeNodeCandidate({ type: "if", tag: "if", when: "state.x" }),
    undefined,
  );
});

test("actions accept remove and whole-segment path templates", () => {
  assert.equal(isRuntimeAction({ type: "remove", path: "todos.0" }), true);
  assert.equal(
    isRuntimeAction({
      type: "toggle",
      path: "todos.{{event.payload.index}}.done",
    }),
    true,
  );
  assert.equal(
    isRuntimeAction({ type: "toggle", path: "todos.{{event.payload.index" }),
    false,
  );
  assert.equal(
    isRuntimeAction({ type: "toggle", path: "todos.{{1 + 1}}.done" }),
    false,
  );
});

test("state paths address array items without replacing arrays", () => {
  const state = {
    todos: [
      { id: 1, done: false },
      { id: 2, done: false },
    ],
    profile: { name: "Ada" },
  };

  assert.equal(setValueByPath(state, "todos.1.done", true), true);
  assert.equal(state.todos[1]?.done, true);
  assert.equal(setValueByPath(state, "todos.5.done", true), false);
  assert.equal(setValueByPath(state, "todos.first", true), false);
  assert.equal(Array.isArray(state.todos), true);
  assert.equal(state.todos.length, 2);

  assert.equal(removeValueByPath(state, "todos.0"), true);
  assert.deepEqual(state.todos, [{ id: 2, done: true }]);
  assert.equal(removeValueByPath(state, "todos.3"), false);
  assert.equal(removeValueByPath(state, "profile.name"), true);
  assert.deepEqual(state.profile, {});
  assert.equal(removeValueByPath(state, "__proto__.polluted"), false);

  const values: Record<string, unknown> = {
    "event.payload.index": 3,
    "event.payload.key": "a.b",
    "event.payload.proto": "__proto__",
    "event.payload.object": { nested: true },
    "event.payload.negative": -1,
  };
  const resolve = (expression: string) => values[expression];
  assert.equal(
    resolveRuntimeStatePath("todos.{{event.payload.index}}.done", resolve),
    "todos.3.done",
  );
  assert.equal(resolveRuntimeStatePath("todos.count", resolve), "todos.count");
  for (const expression of ["key", "proto", "object", "negative", "missing"]) {
    assert.equal(
      resolveRuntimeStatePath(`todos.{{event.payload.${expression}}}`, resolve),
      undefined,
      expression,
    );
  }
});

test("conditions follow documented truthiness and equality", () => {
  assert.equal(isRuntimeTruthy([]), false);
  assert.equal(isRuntimeTruthy([0]), true);
  assert.equal(isRuntimeTruthy(""), false);
  assert.equal(isRuntimeTruthy(0), false);
  assert.equal(isRuntimeTruthy({}), true);

  assert.equal(areRuntimeValuesEqual(2, "2"), true);
  assert.equal(areRuntimeValuesEqual(true, "true"), true);
  assert.equal(areRuntimeValuesEqual(null, undefined), true);
  assert.equal(areRuntimeValuesEqual(null, ""), false);
  assert.equal(areRuntimeValuesEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(areRuntimeValuesEqual({ a: 1 }, "[object Object]"), false);
});

test("event payload references resolve once against current state", () => {
  const state: Record<string, unknown> = {
    query: "fresh",
    form: { name: "Ada", nested: { $from: "state.query" } },
  };
  const resolve = (path: string) =>
    path.startsWith("state.") ? state[path.slice(6)] : undefined;

  const literal: RuntimeEvent = { type: "save", payload: { id: 7 } };
  assert.equal(resolveRuntimeEventReferences(literal, resolve), literal);

  assert.deepEqual(
    resolveRuntimeEventReferences(
      {
        type: "tool:search",
        payload: { query: { $from: "state.query" }, filters: ["a"] },
      },
      resolve,
    ),
    { type: "tool:search", payload: { query: "fresh", filters: ["a"] } },
  );

  // A whole-payload reference becomes the payload; resolved data is not
  // scanned for further references.
  assert.deepEqual(
    resolveRuntimeEventReferences(
      { type: "tool:save", payload: { $from: "state.form" } },
      resolve,
    ).payload,
    { name: "Ada", nested: { $from: "state.query" } },
  );
  assert.deepEqual(
    resolveRuntimeEventReferences(
      { type: "tool:save", payload: { $from: "state.query" } },
      resolve,
    ).payload,
    { value: "fresh" },
  );
});

test("runtime expands each and if with loop scope and stable keys", async () => {
  const runtime = await createRuntime();
  try {
    const result = await runtime.executePlan(createTodoPlan());
    assert.deepEqual(
      result.diagnostics.filter((item) => item.level !== "info"),
      [],
    );

    const items = collectElements(result.root, "li");
    assert.deepEqual(items.map(textOf), [
      "0: Write docsRemove",
      "1: Ship (done)Remove",
    ]);
    assert.deepEqual(
      items.map((item) => item.props?.key),
      ["1", "2"],
    );

    const [draft, firstCheck, secondCheck] = collectElements(
      result.root,
      "input",
    );
    assert.equal(draft?.props?.value, "");
    assert.equal(draft?.props?.bind, "draft");
    assert.equal(firstCheck?.props?.bind, "todos.0.done");
    assert.equal(firstCheck?.props?.checked, false);
    assert.equal(secondCheck?.props?.bind, "todos.1.done");
    assert.equal(secondCheck?.props?.checked, true);

    const removeButtons = collectElements(result.root, "button").slice(1);
    assert.deepEqual(
      removeButtons.map((button) => button.props?.onClick),
      [
        { type: "remove", payload: { index: 0 } },
        { type: "remove", payload: { index: 1 } },
      ],
    );
    assert.equal(collectElements(result.root, "p").length, 0);
  } finally {
    await runtime.terminate();
  }
});

test("runtime transitions add, toggle, and remove list items", async () => {
  const runtime = await createRuntime();
  const plan = createTodoPlan();
  try {
    await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "draft", value: "Buy milk" },
      },
    );
    let result = await runtime.executePlan(plan, {}, { type: "add" });
    assert.deepEqual(result.state?.todos, [
      { id: 1, title: "Write docs", done: false },
      { id: 2, title: "Ship", done: true },
      { id: 3, title: "Buy milk", done: false },
    ]);
    assert.equal(result.state?.draft, "");
    assert.equal(result.state?.nextId, 4);
    assert.equal(collectElements(result.root, "input")[0]?.props?.value, "");

    result = await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "todos.0.done", value: true },
      },
    );
    assert.equal(todosOf(result)[0]?.done, true);
    assert.match(textOf(result.root), /0: Write docs \(done\)/);

    result = await runtime.executePlan(
      plan,
      {},
      {
        type: "remove",
        payload: { index: 1 },
      },
    );
    assert.deepEqual(
      todosOf(result).map((todo) => todo.id),
      [1, 3],
    );
    assert.deepEqual(result.appliedActions, [
      { type: "remove", path: "todos.1" },
    ]);

    result = await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "todos.9.done", value: true },
      },
    );
    assert.deepEqual(result.appliedActions, []);
    assert.equal(todosOf(result).length, 2);

    result = await runtime.executePlan(
      plan,
      {},
      {
        type: "remove",
        payload: { index: 9 },
      },
    );
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_ACTION_TARGET_MISSING",
      ),
    );
    result = await runtime.executePlan(
      plan,
      {},
      {
        type: "remove",
        payload: { index: "__proto__" },
      },
    );
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_ACTION_PATH_UNRESOLVED",
      ),
    );
    assert.equal(todosOf(result).length, 2);

    for (const _ of [1, 3]) {
      result = await runtime.executePlan(
        plan,
        {},
        {
          type: "remove",
          payload: { index: 0 },
        },
      );
    }
    assert.deepEqual(result.state?.todos, []);
    assert.deepEqual(collectElements(result.root, "p").map(textOf), [
      "Nothing to do",
    ]);
  } finally {
    await runtime.terminate();
  }
});

test("bind events write their path and reject unsafe paths", async () => {
  const runtime = await createRuntime();
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "interaction_bind_events",
    version: 1,
    capabilities: { domWrite: true },
    root: { type: "text", value: "{{state.profile.name}}" },
  };
  try {
    let result = await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "state.profile.name", value: "Ada" },
      },
    );
    assert.deepEqual(result.state, { profile: { name: "Ada" } });
    assert.equal(textOf(result.root), "Ada");

    result = await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "__proto__.polluted", value: "yes" },
      },
    );
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_BIND_EVENT_INVALID",
      ),
    );
    assert.equal(
      (Object.prototype as Record<string, unknown>).polluted,
      undefined,
    );
  } finally {
    await runtime.terminate();
  }
});

test("event payload references read state when the event is handled", async () => {
  const runtime = await createRuntime();
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "interaction_payload_refs",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "input",
      props: { bind: "query" },
    },
    state: {
      initial: { query: "initial", log: [] },
      transitions: {
        search: [
          {
            type: "push",
            path: "log",
            value: { $from: "event.payload.query" },
          },
        ],
      },
    },
  };
  try {
    await runtime.executePlan(
      plan,
      {},
      {
        type: RUNTIME_BIND_EVENT_TYPE,
        payload: { path: "query", value: "fresh" },
      },
    );
    const result = await runtime.executePlan(
      plan,
      {},
      {
        type: "search",
        payload: { query: { $from: "state.query" } },
      },
    );
    assert.deepEqual(result.handledEvent, {
      type: "search",
      payload: { query: "fresh" },
    });
    assert.deepEqual(result.state?.log, ["fresh"]);
  } finally {
    await runtime.terminate();
  }
});

test("control nodes in root position render inside a neutral wrapper", async () => {
  const runtime = await createRuntime();
  try {
    const result = await runtime.executePlan({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_root_each",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "each",
        items: "state.tags",
        children: [{ type: "text", value: "#{{item}} " }],
      },
      state: { initial: { tags: ["a", "b"] } },
    });
    assert.equal(result.root.type, "element");
    assert.deepEqual((result.root as RuntimeElementNode).props, {
      "data-renderify-fragment": "each",
      style: "display:contents",
    });
    assert.equal(textOf(result.root), "#a #b ");
  } finally {
    await runtime.terminate();
  }
});

test("if compares against templated values and supports not", async () => {
  const runtime = await createRuntime();
  try {
    const result = await runtime.executePlan({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_if_equals",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "div",
        children: [
          {
            type: "each",
            items: "state.items",
            children: [
              {
                type: "if",
                when: "state.selected",
                equals: "{{item.id}}",
                children: [{ type: "text", value: "[{{item.id}}]" }],
              },
              {
                type: "if",
                when: "state.selected",
                equals: "{{item.id}}",
                not: true,
                children: [{ type: "text", value: "{{item.id}}" }],
              },
            ],
          },
        ],
      },
      state: { initial: { selected: 2, items: [{ id: 1 }, { id: 2 }] } },
    });
    assert.equal(textOf(result.root), "1[2]");
  } finally {
    await runtime.terminate();
  }
});

test("each reports non-array items and stops at the expansion budget", async () => {
  const runtime = await createRuntime();
  try {
    const invalid = await runtime.executePlan({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_each_invalid",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "ul",
        children: [{ type: "each", items: "state.count", children: [] }],
      },
      state: { initial: { count: 3 } },
    });
    assert.ok(
      invalid.diagnostics.some(
        (item) => item.code === "RUNTIME_EACH_ITEMS_INVALID",
      ),
    );

    const large = await runtime.executePlan({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_each_budget",
      version: 1,
      capabilities: { domWrite: true, maxExecutionMs: 30_000 },
      root: {
        type: "element",
        tag: "ul",
        children: [
          {
            type: "each",
            items: "state.rows",
            children: [{ type: "text", value: "{{item}}" }],
          },
        ],
      },
      state: {
        initial: { rows: Array.from({ length: 12_000 }, (_, index) => index) },
      },
    });
    const limit = large.diagnostics.filter(
      (item) => item.code === "RUNTIME_EACH_LIMIT_EXCEEDED",
    );
    assert.equal(limit.length, 1);
    assert.equal(
      large.root.type === "element" ? large.root.children?.length : 0,
      10_000,
    );
  } finally {
    await runtime.terminate();
  }
});

test("bind fills control values and never binds password or file inputs", async () => {
  const runtime = await createRuntime();
  try {
    const result = await runtime.executePlan({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_bind_props",
      version: 1,
      capabilities: { domWrite: true },
      root: {
        type: "element",
        tag: "fieldset",
        children: [
          {
            type: "element",
            tag: "input",
            props: { type: "password", bind: "secret" },
          },
          {
            type: "element",
            tag: "textarea",
            props: { bind: "notes" },
            children: [{ type: "text", value: "ignored" }],
          },
          { type: "element", tag: "select", props: { bind: "size" } },
          {
            type: "element",
            tag: "input",
            props: { type: "radio", value: "m", bind: "size" },
          },
          { type: "element", tag: "div", props: { bind: "notes" } },
        ],
      },
      state: { initial: { secret: "hunter2", notes: "Line", size: "m" } },
    });
    const [password, radio] = collectElements(result.root, "input");
    assert.deepEqual(password?.props, { type: "password" });
    assert.equal(radio?.props?.checked, true);
    const [textarea] = collectElements(result.root, "textarea");
    assert.equal(textarea?.props?.value, "Line");
    assert.equal(textOf(textarea ?? result.root), "Line");
    assert.equal(collectElements(result.root, "select")[0]?.props?.value, "m");
    assert.equal(
      collectElements(result.root, "div")[0]?.props?.bind,
      undefined,
    );
    assert.equal(
      result.diagnostics.filter((item) => item.code === "RUNTIME_BIND_INVALID")
        .length,
      2,
    );
    assert.doesNotMatch(JSON.stringify(result.root), /hunter2/);
  } finally {
    await runtime.terminate();
  }
});

test("security checks look inside control nodes and bindings", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();
  const plan = (root: RuntimeNode, extra: Partial<RuntimePlan> = {}) =>
    ({
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "interaction_security",
      version: 1,
      capabilities: { domWrite: true },
      root,
      ...extra,
    }) as RuntimePlan;

  const hiddenScript = await checker.checkPlan(
    plan({
      type: "if",
      when: "state.x",
      children: [
        {
          type: "each",
          items: "state.rows",
          children: [{ type: "element", tag: "script" }],
        },
      ],
    }),
  );
  assert.ok(hiddenScript.issues.some((issue) => /Blocked tag/.test(issue)));

  const badBind = await checker.checkPlan(
    plan({ type: "element", tag: "input", props: { bind: "event.payload.x" } }),
  );
  assert.ok(badBind.issues.some((issue) => /Invalid bind path/.test(issue)));

  const badPayload = await checker.checkPlan(
    plan({
      type: "element",
      tag: "button",
      props: {
        onClick: { type: "tool:send", payload: { token: { $from: "secret" } } },
      },
    }),
  );
  assert.ok(
    badPayload.issues.some((issue) =>
      /Unsupported value source in onClick payload: secret/.test(issue),
    ),
  );

  const nestedValue = await checker.checkPlan(
    plan(
      { type: "text", value: "x" },
      {
        state: {
          initial: { todos: [] },
          transitions: {
            add: [
              {
                type: "push",
                path: "todos",
                value: { title: { $from: "draft" } },
              },
              { type: "toggle", path: "todos.{{event.payload.index}}.done" },
            ],
          },
        },
      },
    ),
  );
  assert.deepEqual(nestedValue.issues, [
    "Unsupported value source in add: draft",
  ]);
});

test("the shared schema describes lists, conditions, bind, and remove", () => {
  const root = RUNTIME_PLAN_JSON_SCHEMA.properties as Record<
    string,
    { properties: Record<string, { enum?: unknown[] }> }
  >;
  const nodeProperties = root.root?.properties ?? {};
  for (const key of ["items", "as", "index", "key", "when", "equals", "not"]) {
    assert.ok(nodeProperties[key], key);
  }
  const state = root.state as unknown as {
    properties: {
      transitions: {
        additionalProperties: {
          items: { properties: { type: { enum: string[] } } };
        };
      };
    };
  };
  assert.deepEqual(
    state.properties.transitions.additionalProperties.items.properties.type
      .enum,
    ["set", "increment", "toggle", "push", "remove"],
  );
});

test("renderer wires bind and onEnter without leaking the bind prop", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode({
    type: "element",
    tag: "div",
    children: [
      {
        type: "element",
        tag: "input",
        props: { bind: "draft", value: "x", onEnter: "add" },
      },
      {
        type: "element",
        tag: "input",
        props: { type: "password", bind: "secret" },
      },
      { type: "if", when: "state.x", children: [] },
    ],
  });
  assert.match(html, /<input data-renderify-bind="bind_1" value="x"/);
  assert.match(html, /data-renderify-event-enter="evt_1"/);
  assert.doesNotMatch(html, / bind=/);
  assert.equal(html.match(/data-renderify-bind=/g)?.length, 1);
  assert.match(html, /data-renderify-unresolved-control="if"/);
});

test("MCP plans may use lists, conditions, and bound inputs", () => {
  const plan = createTodoPlan();
  assert.deepEqual(parseDeclarativeMcpPlan(plan), plan);

  const withChild = (child: RuntimeNode): RuntimePlan => ({
    ...createTodoPlan(),
    root: {
      type: "each",
      items: "state.todos",
      children: [{ type: "if", when: "item.done", children: [child] }],
    },
  });
  assert.throws(
    () =>
      parseDeclarativeMcpPlan(
        withChild({ type: "component", module: "npm:widget" }),
      ),
    (error: unknown) =>
      error instanceof DeclarativeMcpPlanError &&
      error.code === "COMPONENT_NODES_DISABLED",
  );
  assert.throws(
    () =>
      parseDeclarativeMcpPlan(withChild({ type: "element", tag: "animate" })),
    (error: unknown) =>
      error instanceof DeclarativeMcpPlanError &&
      error.code === "TIMERS_DISABLED",
  );
});
