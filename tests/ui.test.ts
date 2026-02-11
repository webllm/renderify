import assert from "node:assert/strict";
import test from "node:test";
import {
  createElementNode,
  createTextNode,
  type RuntimeExecutionResult,
} from "../packages/ir/src/index";
import { DefaultUIRenderer } from "../packages/ui/src/index";

test("ui renderer can stringify preact render artifacts", async () => {
  const preact = (await import("preact")) as {
    h: (
      type: string,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => unknown;
  };

  const renderer = new DefaultUIRenderer();
  const result: RuntimeExecutionResult = {
    planId: "ui_preact_artifact_test",
    root: createTextNode("fallback"),
    diagnostics: [],
    renderArtifact: {
      mode: "preact-vnode",
      payload: preact.h("section", { class: "demo" }, "hello preact"),
    },
  };

  const html = await renderer.render(result);
  assert.match(html, /<section/);
  assert.match(html, /hello preact/);
});

test("ui renderer serializes runtime event props into delegated attributes", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode(
      "button",
      {
        class: "primary",
        onClick: "increment",
      },
      [createTextNode("Increase")],
    ),
  );

  assert.match(html, /data-renderify-event-click=/);
  assert.match(html, /class="primary"/);
  assert.match(html, /Increase/);
  assert.doesNotMatch(html, /onClick/);
});

test("ui renderer supports structured runtime event payload props", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode(
      "button",
      {
        onClick: {
          type: "setMetric",
          payload: {
            metric: "users",
          },
        },
      },
      [createTextNode("Users")],
    ),
  );

  assert.match(html, /data-renderify-event-click=/);
  assert.match(html, /Users/);
});

test("ui renderer serializes key prop into internal data key", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode(
      "li",
      {
        key: "metric-users",
        class: "item",
      },
      [createTextNode("Users")],
    ),
  );

  assert.match(html, /data-renderify-key="metric-users"/);
  assert.doesNotMatch(html, /\skey=/);
});
