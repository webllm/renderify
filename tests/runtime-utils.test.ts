import assert from "node:assert/strict";
import test from "node:test";
import { withRemainingBudget } from "../packages/runtime/src/runtime-budget";
import {
  interpolateTemplate,
  resolveJsonValue,
} from "../packages/runtime/src/template";

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

test("withRemainingBudget rejects when execution budget is exhausted", async () => {
  await assert.rejects(
    () =>
      withRemainingBudget(
        async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 30);
          });
          return "late";
        },
        {
          startedAt: nowMs(),
          maxExecutionMs: 5,
        },
        "budget exceeded",
      ),
    /budget exceeded/,
  );
});

test("withRemainingBudget throws AbortError when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      withRemainingBudget(
        async () => "ok",
        {
          startedAt: nowMs(),
          maxExecutionMs: 200,
          signal: controller.signal,
        },
        "budget exceeded",
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("interpolateTemplate resolves state/context/event/vars paths", () => {
  const resolved = interpolateTemplate(
    "count={{state.count}}, user={{context.userId}}, metric={{vars.metric}}, event={{event.type}}",
    {
      userId: "user_123",
      variables: {
        metric: "sessions",
      },
    },
    {
      count: 7,
    },
    {
      type: "click",
    },
  );

  assert.equal(
    resolved,
    "count=7, user=user_123, metric=sessions, event=click",
  );
});

test("resolveJsonValue handles circular structures without throwing", () => {
  const circular: Record<string, unknown> = {
    label: "node",
  };
  circular.self = circular;

  const resolved = resolveJsonValue(
    circular as never,
    {},
    {},
    undefined,
  ) as Record<string, unknown>;

  assert.equal(resolved.label, "node");
  assert.equal(resolved.self, null);
});

test("interpolateTemplate safely handles circular object values", () => {
  const circular: Record<string, unknown> = {
    label: "node",
  };
  circular.self = circular;

  const resolved = interpolateTemplate(
    "node={{state.circular}}",
    {},
    {
      circular: circular as never,
    },
    undefined,
  );

  assert.equal(resolved, "node=");
});

test("interpolateTemplate truncates deeply nested object serialization", () => {
  let deep: Record<string, unknown> = {
    leaf: true,
  };

  for (let index = 0; index < 12; index += 1) {
    deep = {
      next: deep,
    };
  }

  const resolved = interpolateTemplate(
    "value={{state.deep}}",
    {},
    {
      deep: deep as never,
    },
    undefined,
  );

  assert.match(resolved, /\[Truncated\]/);
});

test("interpolateTemplate caps oversized serialized object payloads", () => {
  const huge = {
    data: "x".repeat(10000),
  };

  const resolved = interpolateTemplate(
    "blob={{state.huge}}",
    {},
    {
      huge: huge as never,
    },
    undefined,
  );

  assert.match(resolved, /^blob=/);
  assert.match(resolved, /\.\.\.$/);
  assert.ok(
    resolved.length <= 4104,
    `expected capped template output, got length=${resolved.length}`,
  );
});
