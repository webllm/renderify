import assert from "node:assert/strict";
import test from "node:test";
import {
  asJsonValue,
  collectComponentModules,
  createComponentNode,
  createElementNode,
  createFnv1a64Hasher,
  createTextNode,
  getValueByPath,
  hashStringFNV1a32,
  hashStringFNV1a32Base36,
  hashStringFNV1a64Hex,
  isJsonValue,
  isRuntimeCapabilities,
  isRuntimeModuleDescriptor,
  isRuntimeModuleManifest,
  isRuntimeNode,
  isRuntimePlan,
  isRuntimeSourceModule,
  isRuntimeSourceRuntime,
  isRuntimeStateModel,
  isSafePath,
  normalizeRuntimeNodeCandidate,
  normalizeRuntimePlanCandidate,
  type RuntimeNode,
  type RuntimeStateSnapshot,
  resolveRuntimePlanSpecVersion,
  setValueByPath,
  walkRuntimeNode,
} from "../packages/ir/src/index";

test("isRuntimeNode validates supported node kinds", () => {
  assert.equal(isRuntimeNode(createTextNode("hello")), true);
  assert.equal(isRuntimeNode(createElementNode("div")), true);
  assert.equal(
    isRuntimeNode(createComponentNode("npm:@scope/widget", "default")),
    true,
  );

  assert.equal(isRuntimeNode({ type: "element" }), false);
  assert.equal(isRuntimeNode({ type: "element", tag: "" }), false);
  assert.equal(isRuntimeNode({ type: "component", module: "" }), false);
  assert.equal(isRuntimeNode({ type: "unknown" }), false);
  assert.equal(isRuntimeNode("text"), false);
});

test("runtime node guards reject misplaced plan fields", () => {
  const rootWithPlanFields = {
    type: "element",
    tag: "main",
    children: [{ type: "text", value: "Todo" }],
    state: { initial: { count: 0 } },
    capabilities: { domWrite: true },
  };

  assert.equal(isRuntimeNode(rootWithPlanFields), false);
  assert.equal(normalizeRuntimeNodeCandidate(rootWithPlanFields), undefined);
  assert.equal(
    normalizeRuntimePlanCandidate({
      id: "misplaced_plan_fields",
      version: 1,
      root: rootWithPlanFields,
      capabilities: { domWrite: true },
    }),
    undefined,
  );
  assert.equal(
    isRuntimeNode({ type: "text", value: "Todo", metadata: {} }),
    false,
  );
  assert.equal(
    isRuntimeNode({
      type: "component",
      module: "widget",
      imports: [],
    }),
    false,
  );
});

test("runtime candidate normalization converts common LLM DOM-like JSON", () => {
  const normalizedNode = normalizeRuntimeNodeCandidate({
    type: "div",
    style: { color: "green" },
    children: [
      { type: "span", children: ["Healthy"] },
      { type: "text", text: "ready" },
    ],
  });

  assert.deepEqual(normalizedNode, {
    type: "element",
    tag: "div",
    props: { style: { color: "green" } },
    children: [
      {
        type: "element",
        tag: "span",
        children: [{ type: "text", value: "Healthy" }],
      },
      { type: "text", value: "ready" },
    ],
  });

  const normalizedPlan = normalizeRuntimePlanCandidate(
    {
      version: "runtime-plan/v1",
      nodes: [{ type: "container", nodes: ["legacy root"] }],
    },
    { fallbackId: "normalized_llm_plan" },
  );
  assert.ok(normalizedPlan);
  assert.equal(normalizedPlan?.id, "normalized_llm_plan");
  assert.equal(normalizedPlan?.version, 1);
  assert.equal(normalizedPlan?.specVersion, "runtime-plan/v1");
  assert.equal(isRuntimePlan(normalizedPlan), true);
});

test("runtime candidate normalization applies aliases to valid node shells", () => {
  const aliasedRoot = {
    type: "element" as const,
    tag: "div",
    style: { color: "red" },
    nodes: [
      {
        type: "element" as const,
        tag: "span",
        className: "status",
        nodes: [{ type: "text" as const, value: "ready" }],
      },
    ],
  };
  const expectedRoot = {
    type: "element",
    tag: "div",
    props: { style: { color: "red" } },
    children: [
      {
        type: "element",
        tag: "span",
        props: { class: "status" },
        children: [{ type: "text", value: "ready" }],
      },
    ],
  };

  assert.equal(isRuntimeNode(aliasedRoot), false);
  assert.deepEqual(normalizeRuntimeNodeCandidate(aliasedRoot), expectedRoot);
  assert.deepEqual(
    normalizeRuntimePlanCandidate({
      id: "aliased_valid_shell_plan",
      version: 1,
      root: aliasedRoot,
    })?.root,
    expectedRoot,
  );
});

test("runtime candidate normalization maps label attribute aliases", () => {
  assert.deepEqual(
    normalizeRuntimeNodeCandidate({
      type: "label",
      htmlFor: "email",
      children: ["Email"],
    }),
    {
      type: "element",
      tag: "label",
      props: { for: "email" },
      children: [{ type: "text", value: "Email" }],
    },
  );
  assert.deepEqual(
    normalizeRuntimeNodeCandidate({
      type: "label",
      for: "canonical",
      htmlFor: "must-not-win",
    }),
    {
      type: "element",
      tag: "label",
      props: { for: "canonical" },
      children: [],
    },
  );
});

test("runtime candidate normalization rejects ambiguous child aliases", () => {
  for (const nodes of [
    [{ type: "text", value: "legacy content" }],
    "invalid legacy children",
  ]) {
    const root = {
      type: "element",
      tag: "div",
      children: [{ type: "text", value: "runtime content" }],
      nodes,
    };

    assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
    assert.equal(
      normalizeRuntimePlanCandidate({
        id: "ambiguous_children_plan",
        version: 1,
        root,
      }),
      undefined,
    );
  }
});

test("runtime plan normalization rejects ambiguous root aliases", () => {
  for (const nodes of [
    [{ type: "text", value: "legacy content" }],
    [],
    undefined,
  ]) {
    const candidate = {
      id: "ambiguous_root_plan",
      version: 1,
      root: { type: "text", value: "runtime content" },
      nodes,
    };

    assert.equal(normalizeRuntimePlanCandidate(candidate), undefined);
  }
});

test("runtime candidate normalization rejects explicitly invalid tags", () => {
  for (const tag of [undefined, null, "", "   ", 42, true, [], {}]) {
    for (const type of ["div", "container"] as const) {
      const root = { type, tag, children: ["content"] };

      assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
      assert.equal(
        normalizeRuntimePlanCandidate({
          id: "invalid_explicit_tag_plan",
          version: 1,
          root,
        }),
        undefined,
      );
    }
  }

  assert.deepEqual(normalizeRuntimeNodeCandidate({ type: "div" }), {
    type: "element",
    tag: "div",
    children: [],
  });
  assert.deepEqual(normalizeRuntimeNodeCandidate({ type: "container" }), {
    type: "element",
    tag: "div",
    children: [],
  });
});

test("runtime candidate normalization requires coherent tag discriminators", () => {
  for (const root of [
    { type: "NOT A TAG", tag: "div" },
    { type: " element ", tag: "div" },
    { type: "unknown/type", tag: "div" },
    { type: "section", tag: "div" },
  ]) {
    assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
    assert.equal(
      normalizeRuntimePlanCandidate({
        id: "incoherent_tag_discriminator_plan",
        version: 1,
        root,
      }),
      undefined,
    );
  }

  assert.deepEqual(
    normalizeRuntimeNodeCandidate({ type: "section", tag: "section" }),
    { type: "element", tag: "section", children: [] },
  );
  assert.deepEqual(
    normalizeRuntimeNodeCandidate({ type: "section", tag: "SECTION" }),
    { type: "element", tag: "section", children: [] },
  );
});

test("runtime candidate normalization validates aliases on text nodes", () => {
  assert.deepEqual(
    normalizeRuntimeNodeCandidate({
      type: "text",
      value: "same content",
      text: "same content",
    }),
    { type: "text", value: "same content" },
  );

  for (const root of [
    { type: "text", value: "content", style: { color: "red" } },
    { type: "text", value: "content", style: [] },
    { type: "text", value: "content", id: "copy" },
    { type: "text", value: "content", id: null },
    { type: "text", value: "content", className: "copy" },
    { type: "text", value: "content", props: { class: "copy" } },
    { type: "text", value: "content", nodes: [] },
    { type: "text", value: "content", children: [] },
    { type: "text", value: "canonical", text: "conflicting legacy" },
    { type: "element", tag: "div", text: "must not be discarded" },
  ]) {
    assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
    assert.equal(
      normalizeRuntimePlanCandidate({
        id: "invalid_text_alias_plan",
        version: 1,
        root,
      }),
      undefined,
    );
  }
});

test("runtime candidate normalization preserves string style aliases", () => {
  const normalizedNode = normalizeRuntimeNodeCandidate({
    type: "div",
    style: "color:red",
    children: ["styled content"],
  });

  assert.deepEqual(normalizedNode, {
    type: "element",
    tag: "div",
    props: { style: "color:red" },
    children: [{ type: "text", value: "styled content" }],
  });
  assert.equal(
    (
      normalizeRuntimePlanCandidate({
        id: "string_style_plan",
        version: 1,
        root: {
          type: "element",
          tag: "div",
          style: "color:red",
        },
      })?.root as { props?: { style?: unknown } } | undefined
    )?.props?.style,
    "color:red",
  );

  for (const style of [null, [], 42, true]) {
    assert.equal(
      normalizeRuntimeNodeCandidate({ type: "div", style }),
      undefined,
    );
  }
});

test("runtime candidate normalization rejects malformed DOM attribute aliases", () => {
  const invalidValues = [null, [], {}, 42, true];
  for (const alias of [
    "id",
    "title",
    "role",
    "for",
    "htmlFor",
    "class",
    "className",
  ] as const) {
    for (const invalidValue of invalidValues) {
      const root = {
        type: "div",
        [alias]: invalidValue,
        children: ["must not silently drop aliases"],
      };
      assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
      assert.equal(
        normalizeRuntimePlanCandidate({
          id: "invalid_dom_alias_plan",
          version: 1,
          root,
        }),
        undefined,
      );
    }
  }
});

test("runtime candidate normalization rejects explicitly malformed props", () => {
  for (const props of [[], "className", null, 42]) {
    assert.equal(
      normalizeRuntimeNodeCandidate({
        type: "div",
        props,
        children: ["invalid props"],
      }),
      undefined,
    );
    assert.equal(
      normalizeRuntimeNodeCandidate({
        type: "component",
        module: "npm:widget",
        props,
      }),
      undefined,
    );
    assert.equal(
      normalizeRuntimePlanCandidate({
        specVersion: "runtime-plan/v1",
        id: "invalid_props_plan",
        version: 1,
        root: { type: "div", props },
      }),
      undefined,
    );
  }
});

test("runtime candidate normalization rejects primitive roots and incomplete reserved nodes", () => {
  assert.equal(
    normalizeRuntimePlanCandidate(
      { root: "metadata, not a RuntimePlan" },
      { fallbackId: "must_not_be_used" },
    ),
    undefined,
  );
  assert.equal(
    normalizeRuntimePlanCandidate(
      { root: { type: "div", children: ["metadata"] } },
      { fallbackId: "must_not_be_used" },
    ),
    undefined,
  );
  assert.equal(
    normalizeRuntimeNodeCandidate({
      type: "element",
      children: ["missing tag"],
    }),
    undefined,
  );
  for (const root of [
    { type: 42, tag: "div", children: ["invalid type"] },
    { type: null, tag: "div", children: ["invalid type"] },
    { type: "", tag: "div", children: ["invalid type"] },
    { type: "text", value: 42, text: "must not replace invalid value" },
    { type: "text", value: null, text: "must not replace invalid value" },
  ]) {
    assert.equal(normalizeRuntimeNodeCandidate(root), undefined);
    assert.equal(
      normalizeRuntimePlanCandidate({
        id: "invalid_node_discriminator_plan",
        version: 1,
        root,
      }),
      undefined,
    );
  }
});

test("runtime candidate normalization requires a coherent plan envelope", () => {
  const weakCandidates = [
    {
      id: "metadata_record",
      root: { type: "div", children: ["not a plan"] },
    },
    {
      version: 1,
      root: { type: "div", children: ["not a plan"] },
    },
    {
      capabilities: { domWrite: true },
      root: { type: "div", children: ["not a plan"] },
    },
    {
      id: "legacy_metadata_record",
      nodes: ["not a plan"],
    },
    {
      version: 1,
      nodes: ["not a plan"],
    },
    {
      capabilities: { domWrite: true },
      nodes: ["not a plan"],
    },
  ];

  for (const candidate of weakCandidates) {
    assert.equal(
      normalizeRuntimePlanCandidate(candidate, {
        fallbackId: "must_not_promote_metadata",
      }),
      undefined,
    );
  }

  const coherentCandidate = normalizeRuntimePlanCandidate({
    id: "coherent_plan",
    version: 1,
    root: { type: "div", children: ["plan content"] },
  });
  assert.ok(coherentCandidate);
  assert.equal(coherentCandidate?.id, "coherent_plan");

  const strictRootCandidate = normalizeRuntimePlanCandidate(
    {
      version: 1,
      root: { type: "text", value: "strict runtime node" },
    },
    { fallbackId: "strict_root_plan" },
  );
  assert.ok(strictRootCandidate);
  assert.equal(strictRootCandidate?.id, "strict_root_plan");
});

test("runtime candidate normalization only uses legacy nodes when root is absent", () => {
  assert.equal(
    normalizeRuntimePlanCandidate({
      id: "invalid_null_root_plan",
      version: 1,
      root: null,
      nodes: ["must not replace an invalid root"],
    }),
    undefined,
  );

  const legacyPlan = normalizeRuntimePlanCandidate({
    id: "missing_root_legacy_plan",
    version: 1,
    nodes: ["legacy content"],
  });
  assert.deepEqual(legacyPlan?.root, {
    type: "element",
    tag: "div",
    children: [{ type: "text", value: "legacy content" }],
  });
});

test("runtime plan normalization rejects conflicting spec version aliases", () => {
  assert.equal(
    normalizeRuntimePlanCandidate({
      id: "conflicting_spec_alias_plan",
      version: "runtime-plan/v1",
      specVersion: "runtime-plan/v2",
      root: { type: "text", value: "content" },
    }),
    undefined,
  );

  const matchingAliases = normalizeRuntimePlanCandidate({
    id: "matching_spec_alias_plan",
    version: "runtime-plan/v1",
    specVersion: "runtime-plan/v1",
    root: { type: "text", value: "content" },
  });
  assert.equal(matchingAliases?.version, 1);
  assert.equal(matchingAliases?.specVersion, "runtime-plan/v1");
});

test("runtime candidate normalization rejects present invalid semantic fields", () => {
  const basePlan = {
    specVersion: "runtime-plan/v1",
    id: "semantic_validation_plan",
    version: 1,
    root: { type: "div", children: ["content"] },
    capabilities: { domWrite: true },
  };
  const invalidCandidates = [
    { ...basePlan, id: "" },
    { ...basePlan, version: 0 },
    { ...basePlan, specVersion: "" },
    { ...basePlan, capabilities: { domWrite: "yes" } },
    { ...basePlan, imports: ["preact", 42] },
    {
      ...basePlan,
      moduleManifest: { preact: { resolvedUrl: "" } },
    },
    { ...basePlan, state: { initial: [] } },
    {
      ...basePlan,
      source: {
        language: "tsx",
        code: "export default () => <div />",
        runtime: "react",
      },
    },
    { ...basePlan, metadata: { tags: [42] } },
  ];

  for (const candidate of invalidCandidates) {
    assert.equal(
      normalizeRuntimePlanCandidate(candidate, {
        fallbackId: "must_not_replace_invalid_id",
      }),
      undefined,
    );
  }

  const normalizedMissingFields = normalizeRuntimePlanCandidate(
    {
      specVersion: "runtime-plan/v1",
      root: { type: "div", children: ["content"] },
    },
    { fallbackId: "missing_fields_plan" },
  );
  assert.ok(normalizedMissingFields);
  assert.equal(normalizedMissingFields?.id, "missing_fields_plan");
  assert.equal(normalizedMissingFields?.version, 1);
  assert.deepEqual(normalizedMissingFields?.capabilities, {
    domWrite: true,
    allowedModules: [],
  });
});

test("runtime node guards validate descendants, props, and component exports", () => {
  const malformedDescendant = {
    type: "element",
    tag: "main",
    children: [{ type: "text", value: 42 }],
  };
  const malformedProps = {
    type: "element",
    tag: "main",
    props: { callback: () => undefined },
  };
  const malformedExport = {
    type: "component",
    module: "npm:widget",
    exportName: "   ",
  };

  assert.equal(isRuntimeNode(malformedDescendant), false);
  assert.equal(isRuntimeNode(malformedProps), false);
  assert.equal(isRuntimeNode(malformedExport), false);
  assert.equal(
    isRuntimePlan({
      id: "malformed_descendant_plan",
      version: 1,
      root: malformedDescendant,
    }),
    false,
  );
});

test("runtime node guards reject cycles without invoking accessors", () => {
  const cyclic: Record<string, unknown> = {
    type: "element",
    tag: "main",
    children: [],
  };
  (cyclic.children as unknown[]).push(cyclic);

  let getterCalls = 0;
  const accessorNode: Record<string, unknown> = {};
  Object.defineProperty(accessorNode, "type", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "text";
    },
  });
  Object.defineProperty(accessorNode, "value", {
    enumerable: true,
    value: "hidden",
  });

  assert.equal(isRuntimeNode(cyclic), false);
  assert.equal(isRuntimeNode(accessorNode), false);
  assert.equal(getterCalls, 0);

  let visited = 0;
  walkRuntimeNode(
    cyclic as unknown as ReturnType<typeof createElementNode>,
    () => {
      visited += 1;
    },
  );
  assert.equal(visited, 1);
});

test("runtime candidate normalization rejects accessors without invoking them", () => {
  let getterCalls = 0;
  const component: Record<string, unknown> = {
    type: "component",
    module: "npm:widget",
  };
  Object.defineProperty(component, "exportName", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "Named";
    },
  });

  const children: unknown[] = [];
  Object.defineProperty(children, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "child";
    },
  });
  children.length = 1;

  const plan: Record<string, unknown> = {
    version: 1,
    root: { type: "text", value: "content" },
  };
  Object.defineProperty(plan, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "accessor_plan";
    },
  });

  assert.equal(normalizeRuntimeNodeCandidate(component), undefined);
  assert.equal(
    normalizeRuntimeNodeCandidate({ type: "div", children }),
    undefined,
  );
  assert.equal(normalizeRuntimePlanCandidate(plan), undefined);
  assert.equal(getterCalls, 0);

  const canonicalPlan = {
    id: "canonical_data_plan",
    version: 1,
    root: createElementNode("div"),
    capabilities: undefined,
  };
  assert.equal(normalizeRuntimePlanCandidate(canonicalPlan), canonicalPlan);
});

test("runtime candidate normalization bounds canonical node trees", () => {
  const oversizedRoot = {
    type: "element" as const,
    tag: "div",
    children: Array.from({ length: 10_000 }, (_, index) => ({
      type: "text" as const,
      value: String(index),
    })),
  };
  assert.equal(isRuntimeNode(oversizedRoot), true);
  assert.equal(normalizeRuntimeNodeCandidate(oversizedRoot), undefined);
  assert.equal(
    normalizeRuntimePlanCandidate({
      id: "oversized_canonical_plan",
      version: 1,
      root: oversizedRoot,
    }),
    undefined,
  );

  let tooDeepRoot: RuntimeNode = createTextNode("leaf");
  for (let depth = 0; depth <= 512; depth += 1) {
    tooDeepRoot = createElementNode("div", undefined, [tooDeepRoot]);
  }
  assert.equal(isRuntimeNode(tooDeepRoot), true);
  assert.equal(normalizeRuntimeNodeCandidate(tooDeepRoot), undefined);
});

test("runtime node guards and walkers handle very deep trees iteratively", () => {
  const depth = 12_000;
  let root: RuntimeNode = createTextNode("leaf");
  for (let index = 0; index < depth; index += 1) {
    root = createElementNode("div", undefined, [root]);
  }

  assert.equal(isRuntimeNode(root), true);

  let count = 0;
  let maximumDepth = 0;
  walkRuntimeNode(root, (_node, nodeDepth) => {
    count += 1;
    maximumDepth = Math.max(maximumDepth, nodeDepth);
  });

  assert.equal(count, depth + 1);
  assert.equal(maximumDepth, depth);
});

test("walkRuntimeNode traverses tree depth-first and collectComponentModules deduplicates", () => {
  const root = createElementNode("main", undefined, [
    createTextNode("Title"),
    createComponentNode("npm:acme/chart"),
    createElementNode("section", undefined, [
      createComponentNode("npm:acme/chart"),
      createComponentNode("npm:acme/table"),
    ]),
  ]);

  const visited: Array<{ type: string; depth: number }> = [];
  walkRuntimeNode(root, (node, depth) => {
    visited.push({ type: node.type, depth });
  });

  assert.deepEqual(
    visited.map((item) => item.depth),
    [0, 1, 1, 1, 2, 2],
  );

  const modules = collectComponentModules(root).sort();
  assert.deepEqual(modules, ["npm:acme/chart", "npm:acme/table"]);
});

test("walkRuntimeNode skips malformed child payloads", () => {
  const malformedRoot = {
    type: "element",
    tag: "main",
    children: [
      createTextNode("ok"),
      null,
      "string-child",
      { type: "component" },
      createComponentNode("npm:acme/widget"),
    ],
  } as unknown as ReturnType<typeof createElementNode>;

  const visitedTypes: string[] = [];
  walkRuntimeNode(malformedRoot, (node) => {
    visitedTypes.push(node.type);
  });

  assert.deepEqual(visitedTypes, ["element", "text", "component"]);
  assert.deepEqual(collectComponentModules(malformedRoot), ["npm:acme/widget"]);
});

test("path helpers set/get nested values and reject unsafe keys", () => {
  const state: RuntimeStateSnapshot = {};
  setValueByPath(state, "counter.total", 7);
  setValueByPath(state, "__proto__.polluted", "yes");
  setValueByPath(state, "constructor.prototype.polluted", "yes");

  assert.equal(getValueByPath(state, "counter.total"), 7);
  assert.equal(getValueByPath(state, "__proto__.polluted"), undefined);
  assert.equal(getValueByPath({}, "toString"), undefined);
  assert.equal(
    (Object.prototype as { polluted?: unknown }).polluted,
    undefined,
  );
  assert.equal(isSafePath("counter.total"), true);
  assert.equal(isSafePath("__proto__.polluted"), false);
});

test("asJsonValue normalizes undefined and non-finite numbers", () => {
  assert.equal(asJsonValue(undefined), null);
  assert.equal(asJsonValue(Number.NaN), null);
  assert.equal(asJsonValue(Number.POSITIVE_INFINITY), null);
  assert.equal(asJsonValue(42), 42);
  assert.deepEqual(asJsonValue({ ok: true, nested: [1, undefined] }), {
    ok: true,
    nested: [1, null],
  });
});

test("json helpers reject exotic objects and normalize cycles without invoking getters", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  let getterCalls = 0;
  const withGetter: Record<string, unknown> = {};
  Object.defineProperty(withGetter, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "leaked";
    },
  });

  const arrayWithGetter: unknown[] = [];
  Object.defineProperty(arrayWithGetter, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "leaked";
    },
  });
  arrayWithGetter.length = 1;

  const protoKey: Record<string, unknown> = {};
  Object.defineProperty(protoKey, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  const normalizedProtoKey = asJsonValue(protoKey);

  assert.equal(isJsonValue(cyclic), false);
  assert.equal(isJsonValue(new Date()), false);
  assert.equal(isJsonValue(withGetter), false);
  assert.equal(isJsonValue(arrayWithGetter), false);
  assert.deepEqual(asJsonValue(cyclic), { self: null });
  assert.equal(asJsonValue(new Date()), null);
  assert.deepEqual(asJsonValue(withGetter), { secret: null });
  assert.deepEqual(asJsonValue(arrayWithGetter), [null]);
  assert.equal(getterCalls, 0);
  assert.equal(
    typeof normalizedProtoKey === "object" &&
      normalizedProtoKey !== null &&
      !Array.isArray(normalizedProtoKey) &&
      Object.hasOwn(normalizedProtoKey, "__proto__"),
    true,
  );
  assert.equal(
    (Object.prototype as { polluted?: unknown }).polluted,
    undefined,
  );
});

test("runtime plan/type guards validate structures", () => {
  const plan = {
    id: "guard_plan",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("ok")]),
    capabilities: {
      domWrite: true,
      maxExecutionMs: 1000,
    },
    state: {
      initial: { count: 0 },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
      },
    },
  };

  assert.equal(isRuntimeCapabilities(plan.capabilities), true);
  assert.equal(isRuntimeStateModel(plan.state), true);
  assert.equal(isRuntimePlan(plan), true);
  assert.equal(
    isRuntimePlan({
      ...plan,
      capabilities: undefined,
    }),
    true,
  );
  assert.equal(
    isRuntimePlan({
      ...plan,
      capabilities: { ...plan.capabilities, maxExecutionMs: 0 },
    }),
    false,
  );
  assert.equal(
    isRuntimePlan({
      ...plan,
      capabilities: { ...plan.capabilities, executionProfile: "unknown" },
    }),
    false,
  );
  assert.equal(
    isRuntimePlan({
      ...plan,
      capabilities: {
        ...plan.capabilities,
        executionProfile: "sandbox-shadowrealm",
      },
    }),
    true,
  );

  assert.equal(
    isRuntimeSourceModule({
      language: "tsx",
      code: "export default () => <div/>",
      exportName: "default",
      runtime: "preact",
    }),
    true,
  );
  assert.equal(isRuntimeSourceRuntime("preact"), true);
  assert.equal(isRuntimeSourceRuntime("renderify"), true);
  assert.equal(isRuntimeSourceRuntime("react"), false);
  assert.equal(
    isRuntimePlan({
      ...plan,
      specVersion: "runtime-plan/v1",
      source: {
        language: "tsx",
        code: "export default () => <div/>",
      },
      moduleManifest: {
        "npm:nanoid@5": {
          resolvedUrl: "https://ga.jspm.io/npm/nanoid@5",
          signer: "tests",
        },
      },
    }),
    true,
  );
  assert.equal(
    isRuntimePlan({
      ...plan,
      source: {
        language: "tsx",
        code: "",
      },
    }),
    false,
  );

  assert.equal(
    isRuntimeModuleDescriptor({
      resolvedUrl: "https://ga.jspm.io/npm/nanoid@5",
      integrity: "sha512-xyz",
      signer: "tests",
    }),
    true,
  );
  assert.equal(
    isRuntimeModuleManifest({
      "npm:nanoid@5": {
        resolvedUrl: "https://ga.jspm.io/npm/nanoid@5",
      },
    }),
    true,
  );
  assert.equal(resolveRuntimePlanSpecVersion(undefined), "runtime-plan/v1");
});

test("hash helpers provide stable 32-bit and 64-bit fnv outputs", () => {
  const text = "renderify";
  const hash32 = hashStringFNV1a32(text);
  const hash32Base36 = hashStringFNV1a32Base36(text);
  const hash64 = hashStringFNV1a64Hex(text);

  assert.equal(hash32, 495974725);
  assert.equal(hash32Base36, "87agjp");
  assert.equal(hash64, "5c5024d714d50065");
});

test("64-bit fnv hasher supports incremental updates", () => {
  const hasher = createFnv1a64Hasher();
  hasher.update("render");
  hasher.update("ify");

  assert.equal(hasher.digestHex(), hashStringFNV1a64Hex("renderify"));
});
