import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCodeGenerator } from "../packages/core/src/codegen";
import {
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import { DefaultRuntimeManager } from "../packages/runtime/src/index";

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

test("perf regression: codegen parses runtime plan payload under threshold", async () => {
  const codegen = new DefaultCodeGenerator();

  const payload = JSON.stringify({
    id: "perf_codegen_plan",
    version: 1,
    capabilities: {
      domWrite: true,
      maxExecutionMs: 5000,
    },
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "perf" }],
    },
  });

  const started = nowMs();
  for (let i = 0; i < 100; i += 1) {
    await codegen.generatePlan({
      prompt: "perf codegen",
      llmText: payload,
    });
  }
  const elapsed = nowMs() - started;

  assert.ok(elapsed < 1200, `codegen regression: elapsed=${elapsed}ms`);
});

test("perf regression: runtime executes large plan under threshold", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  try {
    const children = Array.from({ length: 1500 }, (_, index) =>
      createElementNode("li", undefined, [createTextNode(`item-${index}`)]),
    );

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "perf_runtime_plan",
      version: 1,
      capabilities: {
        domWrite: true,
      },
      root: createElementNode("ul", undefined, children),
    };

    const started = nowMs();
    const result = await runtime.executePlan(plan);
    const elapsed = nowMs() - started;

    assert.equal(result.root.type, "element");
    assert.ok(elapsed < 2000, `runtime regression: elapsed=${elapsed}ms`);
  } finally {
    await runtime.terminate();
  }
});

test("perf regression: runtime executes deeply nested tree under threshold", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  try {
    const depth = 320;
    let root: RuntimePlan["root"] = createTextNode("leaf");
    for (let index = 0; index < depth; index += 1) {
      root = createElementNode("section", { [`data-depth-${index}`]: "1" }, [
        root,
      ]);
    }

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "perf_runtime_deep_plan",
      version: 1,
      capabilities: {
        domWrite: true,
      },
      root,
    };

    const started = nowMs();
    const result = await runtime.executePlan(plan);
    const elapsed = nowMs() - started;

    assert.equal(result.root.type, "element");
    let traversedDepth = 0;
    let cursor: RuntimePlan["root"] = result.root;
    while (cursor.type === "element" && cursor.children?.length) {
      traversedDepth += 1;
      const nextNode: RuntimePlan["root"] | undefined = cursor.children[0];
      if (!nextNode) {
        break;
      }
      cursor = nextNode;
    }
    assert.ok(traversedDepth >= depth, `deep tree depth=${traversedDepth}`);
    assert.ok(
      elapsed < 2500,
      `runtime deep-tree regression: elapsed=${elapsed}ms`,
    );
  } finally {
    await runtime.terminate();
  }
});
