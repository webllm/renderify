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
