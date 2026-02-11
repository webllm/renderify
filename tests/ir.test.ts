import assert from "node:assert/strict";
import test from "node:test";
import {
  asJsonValue,
  collectComponentModules,
  createComponentNode,
  createElementNode,
  createTextNode,
  getValueByPath,
  isRuntimeCapabilities,
  isRuntimeModuleDescriptor,
  isRuntimeModuleManifest,
  isRuntimeNode,
  isRuntimePlan,
  isRuntimeSourceModule,
  isRuntimeSourceRuntime,
  isRuntimeStateModel,
  isSafePath,
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
  assert.equal(isRuntimeNode({ type: "unknown" }), false);
  assert.equal(isRuntimeNode("text"), false);
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

test("path helpers set/get nested values and reject unsafe keys", () => {
  const state: Record<string, unknown> = {};
  setValueByPath(state as Record<string, any>, "counter.total", 7);

  assert.equal(getValueByPath(state, "counter.total"), 7);
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
