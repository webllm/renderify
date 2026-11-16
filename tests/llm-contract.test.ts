import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptRuntimePlanCandidate,
  createRuntimePlanJsonSchema,
  diagnoseRuntimePlanCandidate,
  RUNTIME_PLAN_INVALID_PAYLOAD_MESSAGE,
  RUNTIME_PLAN_JSON_SCHEMA,
} from "../packages/ir/src/index";

type SchemaNode = {
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: unknown;
  enum?: string[];
};

const validPlan = {
  specVersion: "runtime-plan/v1",
  id: "contract_plan",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "section",
    children: [{ type: "text", value: "Count: {{state.count}}" }],
  },
  state: {
    initial: { count: 0 },
    transitions: {
      increment: [{ type: "increment", path: "count", by: 1 }],
    },
  },
};

test("llm contract schema requires the canonical envelope and closes model-facing objects", () => {
  const schema = RUNTIME_PLAN_JSON_SCHEMA as SchemaNode;
  assert.deepEqual(schema.required, [
    "specVersion",
    "id",
    "version",
    "root",
    "capabilities",
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties?.specVersion?.enum, ["runtime-plan/v1"]);
  assert.deepEqual(
    Object.keys(schema.properties?.capabilities?.properties ?? {}),
    ["domWrite"],
  );
  assert.deepEqual(schema.properties?.state?.required, ["initial"]);
  assert.ok(schema.properties?.source);
  assert.deepEqual(createRuntimePlanJsonSchema(), RUNTIME_PLAN_JSON_SCHEMA);
});

test("llm contract schema bounds node recursion and can omit source", () => {
  const depthOf = (node: SchemaNode | undefined): number => {
    let depth = 0;
    let current = node;
    while (current?.properties?.children?.items?.properties) {
      depth += 1;
      current = current.properties.children.items;
    }
    return depth;
  };
  const shallow = createRuntimePlanJsonSchema({ nodeDepth: 2 }) as SchemaNode;
  assert.equal(depthOf(shallow.properties?.root), 2);
  assert.equal(
    depthOf((RUNTIME_PLAN_JSON_SCHEMA as SchemaNode).properties?.root),
    6,
  );

  const declarative = createRuntimePlanJsonSchema({
    includeSource: false,
  }) as SchemaNode;
  assert.equal(Object.hasOwn(declarative.properties ?? {}, "source"), false);
});

test("llm contract diagnostics are empty for valid plans and specific otherwise", () => {
  assert.deepEqual(diagnoseRuntimePlanCandidate(validPlan), []);
  assert.deepEqual(diagnoseRuntimePlanCandidate([]), [
    "The top-level structured payload must be an object",
  ]);
  const { root: _root, ...withoutRoot } = validPlan;
  assert.deepEqual(diagnoseRuntimePlanCandidate(withoutRoot), [
    "root is required",
  ]);
  assert.deepEqual(
    diagnoseRuntimePlanCandidate({
      ...validPlan,
      root: {
        type: "element",
        tag: "div",
        state: { initial: {} },
      },
    }),
    [
      "root.state is not valid on a RuntimeNode; move state to the RuntimePlan top level",
    ],
  );
  assert.match(
    diagnoseRuntimePlanCandidate({
      ...validPlan,
      root: { type: "text", value: `Total: \${state.count}` },
    })[0] ?? "",
    /unsupported \$\{\.\.\.\} interpolation/,
  );
});

test("llm contract diagnostics respect the configured limit", () => {
  const children = Array.from({ length: 20 }, () => ({
    type: "text",
    value: 1,
  }));
  const diagnostics = diagnoseRuntimePlanCandidate(
    {
      ...validPlan,
      root: { type: "element", tag: "div", children },
    },
    { maxDiagnostics: 3 },
  );
  assert.equal(diagnostics.length, 3);
});

test("llm contract acceptance keeps canonical plans, normalizes recoverable ones, and explains rejects", () => {
  const canonical = acceptRuntimePlanCandidate(validPlan);
  assert.equal(canonical.valid, true);
  if (canonical.valid) {
    assert.equal(canonical.plan, validPlan);
    assert.equal(canonical.normalized, false);
  }

  const { id: _id, ...withoutId } = validPlan;
  const recovered = acceptRuntimePlanCandidate(withoutId, {
    fallbackIdSeed: "response_1",
  });
  assert.equal(recovered.valid, true);
  if (recovered.valid) {
    assert.equal(recovered.normalized, true);
    assert.match(recovered.plan.id, /^renderify_[0-9a-f]{16}$/);
  }

  const rejected = acceptRuntimePlanCandidate({
    ...validPlan,
    root: { type: "element", children: "nope" },
  });
  assert.equal(rejected.valid, false);
  if (!rejected.valid) {
    assert.equal(rejected.errors[0], RUNTIME_PLAN_INVALID_PAYLOAD_MESSAGE);
    assert.ok(rejected.errors.length > 1);
  }
});
