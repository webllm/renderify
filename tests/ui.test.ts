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
  assert.doesNotMatch(html, /bad/);
});

test("ui renderer blocks style/base/form tags at render time", () => {
  const renderer = new DefaultUIRenderer();
  const styleHtml = renderer.renderNode(
    createElementNode("style", undefined, [
      createTextNode("body{display:none}"),
    ]),
  );
  const baseHtml = renderer.renderNode(
    createElementNode("base", { href: "https://evil.example.com/" }),
  );
  const formHtml = renderer.renderNode(
    createElementNode("form", { action: "https://evil.example.com/" }, [
      createTextNode("x"),
    ]),
  );

  assert.match(styleHtml, /data-renderify-sanitized-tag="style"/);
  assert.doesNotMatch(styleHtml, /<style/);
  assert.doesNotMatch(styleHtml, /display:none/);
  assert.match(baseHtml, /data-renderify-sanitized-tag="base"/);
  assert.doesNotMatch(baseHtml, /<base/);
  assert.match(formHtml, /data-renderify-sanitized-tag="form"/);
  assert.doesNotMatch(formHtml, /<form/);
  assert.doesNotMatch(formHtml, />x</);
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

test("ui renderer drops null-byte obfuscated unsafe inline styles", () => {
  const renderer = new DefaultUIRenderer();
  const escapedNullHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "width:exp\\0ression(alert(1));",
      },
      [createTextNode("escaped null style")],
    ),
  );
  const literalNullHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "width:exp\0ression(alert(1));",
      },
      [createTextNode("literal null style")],
    ),
  );

  assert.doesNotMatch(escapedNullHtml, /\sstyle=/);
  assert.doesNotMatch(literalNullHtml, /\sstyle=/);
});

test("ui renderer blocks additional css injection vectors", () => {
  const renderer = new DefaultUIRenderer();
  const vectors = [
    "@import url(https://evil.example/style.css);",
    "@im\\70ort url(https://evil.example/style.css);",
    "behavior:url(#default#time2);",
    "-moz-binding:url(https://evil.example/xbl.xml#payload);",
  ];

  for (const styleValue of vectors) {
    const html = renderer.renderNode(
      createElementNode(
        "div",
        {
          style: styleValue,
        },
        [createTextNode("unsafe style vector")],
      ),
    );

    assert.doesNotMatch(
      html,
      /\sstyle=/,
      `expected style sanitizer to block vector: ${styleValue}`,
    );
  }
});

test("ui renderer tolerates css escape edge cases in safe styles", () => {
  const renderer = new DefaultUIRenderer();
  const safeEscapedHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "color:red;--glyph:\\10ffff;--invalid:\\110000;",
      },
      [createTextNode("safe escape style")],
    ),
  );
  const escapedUrlHtml = renderer.renderNode(
    createElementNode(
      "div",
      {
        style: "background:\\75\\72\\6c(https://example.com/x.png);",
      },
      [createTextNode("escaped url style")],
    ),
  );

  assert.match(
    safeEscapedHtml,
    /\sstyle="color:red;--glyph:\\10ffff;--invalid:\\110000;"/,
  );
  assert.doesNotMatch(escapedUrlHtml, /\sstyle=/);
});
