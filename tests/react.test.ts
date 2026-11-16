import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { RenderifyFrame, RenderifyView } from "../packages/react/src/index";

const require = createRequire(
  new URL("../packages/react/package.json", import.meta.url),
);
// React is a dependency of @renderify/react, not of the repository root.
const { createElement } = require("react") as {
  createElement(type: unknown, props: Record<string, unknown>): unknown;
};
const { renderToString } = require("react-dom/server") as {
  renderToString(element: unknown): string;
};

const plan = {
  specVersion: "runtime-plan/v1",
  id: "react_ssr",
  version: 1,
  capabilities: { domWrite: true },
  root: { type: "text", value: "Hello" },
} as const;

test("react components render an empty host element on the server", () => {
  assert.equal(
    renderToString(createElement(RenderifyView, { plan, className: "plan" })),
    '<div class="plan" data-renderify-status="idle"></div>',
  );
  assert.equal(
    renderToString(
      createElement(RenderifyFrame, {
        source: "export default 1",
        style: { height: 200 },
      }),
    ),
    '<div style="height:200px"></div>',
  );
});
