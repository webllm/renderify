import assert from "node:assert/strict";
import test from "node:test";
import {
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
