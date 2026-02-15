import assert from "node:assert/strict";
import test from "node:test";
import {
  BabelRuntimeSourceTranspiler,
  DefaultRuntimeSourceTranspiler,
} from "../packages/runtime/src/transpiler";

interface BabelCall {
  code: string;
  options: {
    sourceType?: "module";
    presets?: unknown[];
    filename?: string;
    babelrc?: boolean;
    configFile?: boolean;
    comments?: boolean;
  };
}

function installMockBabel(
  transform: (code: string, options: BabelCall["options"]) => { code?: string },
): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "Babel");

  Object.defineProperty(root, "Babel", {
    configurable: true,
    writable: true,
    value: {
      transform,
    },
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(root, "Babel", descriptor);
    } else {
      delete root.Babel;
    }
  };
}

test("transpiler returns js source without invoking Babel", async () => {
  const transpiler = new BabelRuntimeSourceTranspiler();

  const output = await transpiler.transpile({
    code: "export default 1;",
    language: "js",
  });

  assert.equal(output, "export default 1;");
});

test("transpiler configures classic jsx runtime for renderify mode", async () => {
  const calls: BabelCall[] = [];
  const restore = installMockBabel((code, options) => {
    calls.push({ code, options });
    return { code: "compiled" };
  });

  try {
    const transpiler = new BabelRuntimeSourceTranspiler();
    const output = await transpiler.transpile({
      code: "export default () => <section>Hello</section>;",
      language: "jsx",
      runtime: "renderify",
    });

    assert.equal(output, "compiled");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.sourceType, "module");
    assert.deepEqual(calls[0].options.presets, [
      [
        "react",
        {
          runtime: "classic",
          pragma: "__renderify_runtime_h",
          pragmaFrag: "__renderify_runtime_fragment",
        },
      ],
    ]);
  } finally {
    restore();
  }
});

test("transpiler configures tsx + preact automatic runtime", async () => {
  const calls: BabelCall[] = [];
  const restore = installMockBabel((code, options) => {
    calls.push({ code, options });
    return { code: "compiled-preact" };
  });

  try {
    const transpiler = new BabelRuntimeSourceTranspiler();
    const output = await transpiler.transpile({
      code: "export default (props: { name: string }) => <div>{props.name}</div>;",
      language: "tsx",
      runtime: "preact",
      filename: "component.tsx",
    });

    assert.equal(output, "compiled-preact");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.filename, "component.tsx");
    assert.deepEqual(calls[0].options.presets, [
      "typescript",
      [
        "react",
        {
          runtime: "automatic",
          importSource: "preact",
        },
      ],
    ]);
  } finally {
    restore();
  }
});

test("transpiler throws when Babel is missing", async () => {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "Babel");

  delete root.Babel;

  try {
    const transpiler = new BabelRuntimeSourceTranspiler();
    await assert.rejects(
      () =>
        transpiler.transpile({
          code: "export default () => <div/>;",
          language: "jsx",
        }),
      /Babel standalone is not available/,
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(root, "Babel", descriptor);
    }
  }
});

test("transpiler throws when Babel transform returns empty code", async () => {
  const restore = installMockBabel(() => ({}));

  try {
    const transpiler = new BabelRuntimeSourceTranspiler();
    await assert.rejects(
      () =>
        transpiler.transpile({
          code: "export default () => <div/>;",
          language: "jsx",
        }),
      /Babel returned empty output/,
    );
  } finally {
    restore();
  }
});

test("mergeRuntimeHelpers injects helpers only for non-preact runtime", () => {
  const source = "export default () => <div>Hello</div>;";

  const mergedRenderify = BabelRuntimeSourceTranspiler.mergeRuntimeHelpers(
    source,
    "renderify",
  );
  const mergedPreact = BabelRuntimeSourceTranspiler.mergeRuntimeHelpers(
    source,
    "preact",
  );

  assert.match(mergedRenderify, /__renderify_runtime_h/);
  assert.equal(mergedPreact, source);
});

test("default transpiler caches repeated transpile inputs", async () => {
  let callCount = 0;
  const restore = installMockBabel(() => {
    callCount += 1;
    return { code: "compiled-cached" };
  });

  try {
    const transpiler = new DefaultRuntimeSourceTranspiler();
    const input = {
      code: "export default () => <div/>;",
      language: "jsx" as const,
      runtime: "renderify" as const,
      filename: "cached.jsx",
    };

    const first = await transpiler.transpile(input);
    const second = await transpiler.transpile(input);

    assert.equal(first, "compiled-cached");
    assert.equal(second, "compiled-cached");
    assert.equal(callCount, 1);
  } finally {
    restore();
  }
});
