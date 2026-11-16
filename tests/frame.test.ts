import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  createRenderifyFrame,
  createRenderifyFrameDocument,
  DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS,
  guardSourceLoops,
} from "../packages/frame/src/index";
import type { BabelLike } from "../packages/frame/src/loop-guard";
import {
  MAX_ACTION_PAYLOAD_BYTES,
  readFrameToHostMessage,
  readHostToFrameMessage,
} from "../packages/frame/src/protocol";

const require = createRequire(
  new URL("../packages/frame/package.json", import.meta.url),
);
const Babel = require("@babel/standalone") as BabelLike;

test("frame document allows only the runner and module CDNs", () => {
  const { html, csp } = createRenderifyFrameDocument({
    runnerUrl: "https://app.example/assets/runner.js",
    runnerIntegrity: "sha384-abc",
  });
  const directives = new Map(
    csp.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    }),
  );
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(directives.get("script-src"), [
    "'unsafe-inline'",
    "'unsafe-eval'",
    "blob:",
    "https://app.example",
    ...DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS,
  ]);
  assert.deepEqual(directives.get("connect-src"), [
    "blob:",
    ...DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS,
  ]);
  assert.deepEqual(directives.get("form-action"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'none'"]);
  assert.equal(directives.has("frame-src"), false);
  assert.match(
    html,
    /<script src="https:\/\/app\.example\/assets\/runner\.js" integrity="sha384-abc" crossorigin="anonymous"><\/script>/,
  );

  const offline = createRenderifyFrameDocument({
    runnerUrl: "https://app.example/runner.js",
    moduleOrigins: [],
  });
  assert.match(offline.csp, /connect-src blob:;/);
  assert.doesNotMatch(offline.html, /integrity=/);

  assert.throws(
    () => createRenderifyFrameDocument({ runnerUrl: "/runner.js" }),
    /absolute http\(s\) URL/,
  );
  assert.throws(
    () =>
      createRenderifyFrameDocument({
        runnerUrl: "https://app.example/runner.js",
        moduleOrigins: ["https://cdn.example/npm/"],
      }),
    /Invalid module origin/,
  );
});

test("frame document can inline its runner instead of loading it", () => {
  const runnerSource = "globalThis.__runner = 1; // a <!-- marker";
  const { html, csp } = createRenderifyFrameDocument({
    runnerSource,
    moduleOrigins: ["https://ga.jspm.io"],
  });
  assert.ok(html.includes(`<script>${runnerSource}</script>`));
  assert.doesNotMatch(html, /<script src=/);
  assert.match(
    csp,
    /script-src 'unsafe-inline' 'unsafe-eval' blob: https:\/\/ga\.jspm\.io;/,
  );
  assert.match(
    createRenderifyFrameDocument({ runnerSource, moduleOrigins: [] }).csp,
    /script-src 'unsafe-inline' 'unsafe-eval' blob:;/,
  );

  assert.throws(
    () => createRenderifyFrameDocument({}),
    /Either runnerUrl or runnerSource is required/,
  );
  for (const unsafe of [
    "x = '</script>';",
    "x = '</SCRIPT >';",
    "a = '<!--'; b = '<script>';",
  ]) {
    assert.throws(
      () => createRenderifyFrameDocument({ runnerSource: unsafe }),
      /would break its inline script/,
    );
  }
});

test("host validates every message from the frame", () => {
  assert.deepEqual(readFrameToHostMessage({ type: "resize", height: 120 }), {
    type: "resize",
    height: 120,
  });
  assert.equal(
    readFrameToHostMessage({ type: "resize", height: -1 }),
    undefined,
  );
  assert.equal(
    readFrameToHostMessage({ type: "resize", height: Number.NaN }),
    undefined,
  );
  assert.equal(
    readFrameToHostMessage({ type: "navigate", url: "x" }),
    undefined,
  );

  assert.deepEqual(
    readFrameToHostMessage({
      type: "action",
      action: { type: "tool:save", payload: { id: 1 } },
    }),
    { type: "action", action: { type: "tool:save", payload: { id: 1 } } },
  );
  for (const type of ["", "has space", "x".repeat(129), "<script>"]) {
    assert.equal(
      readFrameToHostMessage({ type: "action", action: { type } }),
      undefined,
      type,
    );
  }
  assert.equal(
    readFrameToHostMessage({
      type: "action",
      action: { type: "big", payload: "x".repeat(MAX_ACTION_PAYLOAD_BYTES) },
    }),
    undefined,
  );

  const rendered = readFrameToHostMessage({
    type: "rendered",
    id: 3,
    result: {
      durationMs: 12,
      framework: "runtime-plan",
      planId: "plan",
      diagnostics: [
        { level: "warning", code: "W", message: "m".repeat(5_000) },
        { level: "nope", code: "X", message: "dropped" },
      ],
      state: { count: 1 },
    },
  });
  assert.equal(rendered?.type, "rendered");
  if (rendered?.type === "rendered") {
    assert.equal(rendered.result.diagnostics.length, 1);
    assert.equal(rendered.result.diagnostics[0]?.message.length, 4_001);
    assert.deepEqual(rendered.result.state, { count: 1 });
  }
  assert.equal(
    readFrameToHostMessage({
      type: "rendered",
      id: 3,
      result: { durationMs: 1, framework: "vue", planId: "p", diagnostics: [] },
    }),
    undefined,
  );
});

test("frame validates render and theme requests", () => {
  assert.deepEqual(
    readHostToFrameMessage({
      type: "render",
      id: 1,
      loopTimeoutMs: 1500,
      input: {
        source: "export default 1",
        language: "tsx",
        runtime: "renderify",
      },
    }),
    {
      type: "render",
      id: 1,
      loopTimeoutMs: 1500,
      input: {
        source: "export default 1",
        language: "tsx",
        runtime: "renderify",
      },
    },
  );
  assert.equal(
    readHostToFrameMessage({
      type: "render",
      id: 1,
      loopTimeoutMs: 1500,
      input: { source: "x", language: "python" },
    }),
    undefined,
  );
  assert.deepEqual(
    readHostToFrameMessage({
      type: "theme",
      theme: { colorScheme: "dark", variables: { "--accent": "#f00" } },
    }),
    {
      type: "theme",
      theme: { colorScheme: "dark", variables: { "--accent": "#f00" } },
    },
  );
  for (const variables of [
    { color: "red" },
    { "--x": 1 },
    { "--y": "z".repeat(600) },
  ]) {
    assert.equal(
      readHostToFrameMessage({ type: "theme", theme: { variables } }),
      undefined,
    );
  }
});

test("loop guard stops runaway loops and leaves pausing loops alone", () => {
  const guarded = guardSourceLoops(
    Babel,
    "let spins = 0; while (true) { spins += 1; }",
    { language: "js", limitMs: 50 },
  );
  const startedAt = Date.now();
  assert.throws(
    () => new Function(guarded)(),
    /Renderify stopped a loop that ran longer than 50 ms \(line 1\)/,
  );
  assert.ok(Date.now() - startedAt < 2_000);

  const finite = guardSourceLoops(
    Babel,
    "function sum() { let total = 0; for (let i = 0; i < 1000; i++) total += i; return total; }",
    { language: "js", limitMs: 50 },
  );
  assert.equal(new Function(`${finite}\nreturn sum();`)(), 499_500);

  const pausing = guardSourceLoops(
    Babel,
    "async function f() { while (busy) { await tick(); } for await (const x of s) {} }\nfunction* g() { while (true) yield 1; }",
    { language: "js", limitMs: 50 },
  );
  assert.doesNotMatch(pausing, /renderifyLoopStart/);

  const tsx = guardSourceLoops(
    Babel,
    "type P = { n: number };\nexport default function App(p: P) { for (;;) {} return <b>{p.n}</b>; }",
    { language: "tsx", limitMs: 50 },
  );
  assert.match(tsx, /type P = \{n: number;\};/);
  assert.match(tsx, /<b>\{p\.n\}<\/b>/);
  assert.match(tsx, /renderifyLoopStart/);

  const untouched = "while (true) {}";
  assert.equal(guardSourceLoops(Babel, untouched, { limitMs: 0 }), untouched);
});

test("createRenderifyFrame requires a browser document", () => {
  assert.throws(
    () => createRenderifyFrame({ container: {} as unknown as HTMLElement }),
    /requires a browser document/,
  );
});
