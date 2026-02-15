import assert from "node:assert/strict";
import test from "node:test";
import {
  Grid,
  MetricTile,
  renderifyThemes,
  resolveRenderifyTheme,
  Surface,
  ThemeProvider,
} from "../packages/runtime/src/primitives";

test("resolveRenderifyTheme merges partial overrides", () => {
  const theme = resolveRenderifyTheme({
    name: "custom",
    colors: {
      primary: "#123456",
    },
  });

  assert.equal(theme.name, "custom");
  assert.equal(theme.colors.primary, "#123456");
  assert.equal(
    theme.colors.background,
    renderifyThemes.aurora.colors.background,
  );
});

test("ThemeProvider injects css variable tokens", () => {
  const vnode = ThemeProvider({
    theme: "slate",
    children: "hello",
  }) as unknown as {
    props: {
      "data-renderify-theme"?: string;
      style?: Record<string, string>;
      children?: unknown;
    };
  };

  assert.equal(vnode.props["data-renderify-theme"], "slate");
  assert.equal(vnode.props.style?.["--rf-color-background"], "#0c1117");
  assert.equal(vnode.props.children, "hello");
});

test("Grid primitive applies expected template columns", () => {
  const vnode = Grid({
    columns: 2,
    gap: "10px",
    children: ["a", "b"],
  }) as unknown as {
    props: {
      style?: Record<string, string>;
      children?: unknown[];
    };
  };

  assert.equal(vnode.props.style?.display, "grid");
  assert.equal(
    vnode.props.style?.gridTemplateColumns,
    "repeat(2, minmax(0, 1fr))",
  );
  assert.equal(vnode.props.children?.length, 2);
});

test("MetricTile composes Surface primitive", () => {
  const vnode = MetricTile({
    label: "requests",
    value: "12.3k",
    delta: "+8.2%",
    tone: "success",
  }) as unknown as {
    type: unknown;
    props: {
      padding?: string;
    };
  };

  assert.equal(vnode.type, Surface);
  assert.equal(vnode.props.padding, "var(--rf-space-md)");
});
