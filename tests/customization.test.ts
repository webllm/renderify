import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultCustomizationEngine,
  type RenderifyPlugin,
} from "../packages/core/src/customization";

function plugin(
  name: string,
  hooks: RenderifyPlugin["hooks"],
): RenderifyPlugin {
  return { name, hooks };
}

test("customization register/getPlugins returns a defensive copy", () => {
  const engine = new DefaultCustomizationEngine();
  const first = plugin("first", {});

  engine.registerPlugin(first);
  const plugins = engine.getPlugins();
  plugins.push(plugin("external", {}));

  const current = engine.getPlugins();
  assert.equal(current.length, 1);
  assert.equal(current[0].name, "first");
});

test("customization runHook executes plugins in registration order", async () => {
  const engine = new DefaultCustomizationEngine();
  const order: string[] = [];

  engine.registerPlugin(
    plugin("a", {
      beforeCodeGen: async (payload: unknown) => {
        order.push("a");
        const next = payload as { value: number };
        return { value: next.value + 1 };
      },
    }),
  );

  engine.registerPlugin(
    plugin("b", {
      beforeCodeGen: (payload: unknown) => {
        order.push("b");
        const next = payload as { value: number };
        return { value: next.value * 2 };
      },
    }),
  );

  const result = await engine.runHook(
    "beforeCodeGen",
    { value: 2 },
    {
      traceId: "trace_test",
      hookName: "beforeCodeGen",
    },
  );

  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(result, { value: 6 });
});

test("customization runHook skips plugins without requested hook", async () => {
  const engine = new DefaultCustomizationEngine();

  engine.registerPlugin(
    plugin("no-hook", {
      afterRender: (payload: unknown) => `${String(payload)}!`,
    }),
  );

  const result = await engine.runHook(
    "beforeRuntime",
    { ok: true },
    {
      traceId: "trace_test",
      hookName: "beforeRuntime",
    },
  );

  assert.deepEqual(result, { ok: true });
});

test("customization runHook awaits async handlers and propagates errors", async () => {
  const engine = new DefaultCustomizationEngine();

  engine.registerPlugin(
    plugin("async", {
      beforeRender: async (payload: unknown) => `${String(payload)}-ready`,
    }),
  );

  const transformed = await engine.runHook("beforeRender", "html", {
    traceId: "trace_test",
    hookName: "beforeRender",
  });
  assert.equal(transformed, "html-ready");

  engine.registerPlugin(
    plugin("throws", {
      beforeRender: async () => {
        throw new Error("plugin boom");
      },
    }),
  );

  await assert.rejects(
    () =>
      engine.runHook("beforeRender", "html", {
        traceId: "trace_test",
        hookName: "beforeRender",
      }),
    /plugin boom/,
  );
});
