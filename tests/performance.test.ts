import assert from "node:assert/strict";
import test from "node:test";
import { DefaultPerformanceOptimizer } from "../packages/core/src/performance";

test("performance records duration between start and end", () => {
  const optimizer = new DefaultPerformanceOptimizer();

  optimizer.startMeasurement("pipeline");
  const metric = optimizer.endMeasurement("pipeline");

  assert.ok(metric);
  assert.equal(metric?.label, "pipeline");
  assert.ok((metric?.durationMs ?? -1) >= 0);
  assert.equal(optimizer.getMetrics().length, 1);
});

test("performance endMeasurement returns undefined when timer is missing", () => {
  const optimizer = new DefaultPerformanceOptimizer();

  const metric = optimizer.endMeasurement("missing");
  assert.equal(metric, undefined);
  assert.equal(optimizer.getMetrics().length, 0);
});

test("performance supports concurrent labels and reset clears state", () => {
  const optimizer = new DefaultPerformanceOptimizer();

  optimizer.startMeasurement("a");
  optimizer.startMeasurement("b");

  const metricA = optimizer.endMeasurement("a");
  const metricB = optimizer.endMeasurement("b");

  assert.equal(metricA?.label, "a");
  assert.equal(metricB?.label, "b");
  assert.equal(optimizer.getMetrics().length, 2);

  optimizer.reset();
  assert.deepEqual(optimizer.getMetrics(), []);
  assert.equal(optimizer.endMeasurement("a"), undefined);
});

test("performance getMetrics returns a copy", () => {
  const optimizer = new DefaultPerformanceOptimizer();
  optimizer.startMeasurement("pipeline");
  optimizer.endMeasurement("pipeline");

  const metrics = optimizer.getMetrics();
  metrics.push({
    label: "tamper",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
  });

  assert.equal(optimizer.getMetrics().length, 1);
});

test("performance falls back to Date.now when global performance is unavailable", () => {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "performance");

  if (descriptor && descriptor.configurable === false) {
    return;
  }

  const originalDateNow = Date.now;
  let current = 10_000;
  Date.now = () => {
    current += 25;
    return current;
  };

  Object.defineProperty(root, "performance", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  try {
    const optimizer = new DefaultPerformanceOptimizer();
    optimizer.startMeasurement("fallback");
    const metric = optimizer.endMeasurement("fallback");

    assert.equal(metric?.durationMs, 25);
  } finally {
    Date.now = originalDateNow;
    if (descriptor) {
      Object.defineProperty(root, "performance", descriptor);
    } else {
      delete root.performance;
    }
  }
});
