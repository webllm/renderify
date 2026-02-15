import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextManager } from "../packages/core/src/context";

test("context initializes with default user and app", async () => {
  const manager = new DefaultContextManager();

  await manager.initialize();

  assert.deepEqual(manager.getContext(), {
    user: { id: "anonymous" },
    app: { version: "0.1.0", environment: "development" },
  });
});

test("context update merges nested user fields without losing existing values", async () => {
  const manager = new DefaultContextManager();
  await manager.initialize();

  manager.updateContext({
    user: {
      id: "u_001",
      name: "Ada",
      role: "admin",
    },
  });

  manager.updateContext({
    user: {
      name: "Grace",
    },
  });

  assert.deepEqual(manager.getContext().user, {
    id: "u_001",
    name: "Grace",
    role: "admin",
  });
});

test("context update merges app fields and preserves extensions", async () => {
  const manager = new DefaultContextManager();
  await manager.initialize();

  manager.updateContext({
    app: {
      version: "1.0.0",
      environment: "staging",
    },
    tenantId: "tenant_1",
    featureFlag: true,
  });

  manager.updateContext({
    app: {
      environment: "production",
    },
    featureFlag: false,
  });

  const context = manager.getContext();
  assert.deepEqual(context.app, {
    version: "1.0.0",
    environment: "production",
  });
  assert.equal(context.tenantId, "tenant_1");
  assert.equal(context.featureFlag, false);
});

test("context notifies subscribers on update and supports unsubscribe", async () => {
  const manager = new DefaultContextManager();
  await manager.initialize();

  const calls: string[] = [];

  const unsubscribeA = manager.subscribe((ctx) => {
    calls.push(`A:${String(ctx.user?.id)}`);
  });

  const unsubscribeB = manager.subscribe((ctx) => {
    calls.push(`B:${String(ctx.user?.id)}`);
  });

  manager.updateContext({ user: { id: "user_1" } });
  unsubscribeA();
  manager.updateContext({ user: { id: "user_2" } });
  unsubscribeB();
  manager.updateContext({ user: { id: "user_3" } });

  assert.deepEqual(calls, ["A:user_1", "B:user_1", "B:user_2"]);
});
