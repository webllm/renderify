import assert from "node:assert/strict";
import test from "node:test";
import { DefaultUIRenderer } from "../packages/core/src/ui";
import {
  createElementNode,
  createTextNode,
  type RuntimeExecutionResult,
} from "../packages/ir/src/index";

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

test("ui renderer sanitizes blocked tag names at render time", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode("script", undefined, [createTextNode("bad")]),
  );

  assert.match(html, /data-renderify-sanitized-tag="script"/);
  assert.doesNotMatch(html, /<script/);
});

test("ui renderer blocks base and form tags at render time", () => {
  const renderer = new DefaultUIRenderer();
  const baseHtml = renderer.renderNode(
    createElementNode("base", { href: "https://evil.example.com/" }),
  );
  const formHtml = renderer.renderNode(
    createElementNode("form", { action: "https://evil.example.com/" }, [
      createTextNode("x"),
    ]),
  );

  assert.match(baseHtml, /data-renderify-sanitized-tag="base"/);
  assert.doesNotMatch(baseHtml, /<base/);
  assert.match(formHtml, /data-renderify-sanitized-tag="form"/);
  assert.doesNotMatch(formHtml, /<form/);
});

test("ui renderer drops unsafe javascript urls and adds rel for _blank", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode(
      "a",
      {
        href: "javascript:alert(1)",
        target: "_blank",
      },
      [createTextNode("Open")],
    ),
  );

  assert.doesNotMatch(html, /href=/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("ui renderer drops unsafe inline style values", () => {
  const renderer = new DefaultUIRenderer();
  const html = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "background:url(javascript:alert(1));color:red;",
      },
      [createTextNode("unsafe style")],
    ),
  );

  assert.doesNotMatch(html, /\sstyle=/);
});

test("ui renderer drops escaped and commented unsafe inline style values", () => {
  const renderer = new DefaultUIRenderer();
  const escapedHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "background:\\75\\72\\6c(javascript:alert(1));",
      },
      [createTextNode("escaped style")],
    ),
  );
  const commentedHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "background:u/**/rl(javascript:alert(1));",
      },
      [createTextNode("commented style")],
    ),
  );

  assert.doesNotMatch(escapedHtml, /\sstyle=/);
  assert.doesNotMatch(commentedHtml, /\sstyle=/);
});
