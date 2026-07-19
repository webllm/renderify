import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { preparePlaygroundBrowserExecution } from "../packages/cli/src/playground-browser-execution";
import { bundlePlaygroundRuntimeClient } from "../packages/cli/src/playground-runtime-bundle";
import type { RuntimePlan } from "../packages/ir/src/index";

test("playground prepares JSX with one browser Preact module graph", async () => {
  const plan: RuntimePlan = {
    specVersion: "runtime-plan/v1",
    id: "playground_browser_execution",
    version: 1,
    root: { type: "element", tag: "div" },
    moduleManifest: {
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.mjs",
        version: "10.28.3",
        integrity: "sha384-stale",
        signer: "jspm",
      },
    },
    source: {
      language: "jsx",
      runtime: "preact",
      code: [
        'import { useState } from "preact/hooks";',
        "export default function Counter() {",
        "  const [count, setCount] = useState(0);",
        "  return <button onClick={() => setCount(count + 1)}>{count}</button>;",
        "}",
      ].join("\n"),
    },
  };

  const prepared = await preparePlaygroundBrowserExecution(plan);

  assert.equal(plan.source?.language, "jsx");
  assert.equal(prepared.plan.source?.language, "js");
  assert.match(prepared.plan.source?.code ?? "", /preact\/jsx-runtime/);
  assert.doesNotMatch(prepared.plan.source?.code ?? "", /return <button/);
  assert.equal(prepared.framework, "preact");
  assert.equal(
    prepared.rendererUrl,
    "https://esm.sh/preact@10.28.3?target=es2022",
  );
  for (const specifier of [
    "preact",
    "preact/hooks",
    "preact/jsx-runtime",
    "preact/compat",
  ]) {
    const descriptor = prepared.plan.moduleManifest?.[specifier];
    assert.match(
      descriptor?.resolvedUrl ?? "",
      /^https:\/\/esm\.sh\/preact@10\.28\.3/,
    );
    assert.equal(descriptor?.version, "10.28.3");
    assert.equal(descriptor?.integrity, undefined);
    assert.equal(descriptor?.signer, undefined);
  }
});

test("playground prepares Material UI plans on one React module graph", async () => {
  const plan: RuntimePlan = {
    specVersion: "runtime-plan/v1",
    id: "playground_react_mui_execution",
    version: 1,
    root: { type: "element", tag: "div" },
    imports: ["preact/hooks", "@mui/material"],
    capabilities: {
      domWrite: true,
      allowedModules: ["preact/hooks", "@mui/material"],
    },
    moduleManifest: {
      "preact/hooks": {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.mjs",
        version: "10.28.3",
      },
      "@mui/material": {
        resolvedUrl: "https://ga.jspm.io/npm:@mui/material@9.2.0/index.mjs",
        version: "9.2.0",
      },
    },
    source: {
      language: "jsx",
      runtime: "preact",
      code: [
        'import { useState } from "preact/hooks";',
        'import { Button, TextField } from "@mui/material";',
        "export default function Counter() {",
        "  const [count, setCount] = useState(0);",
        "  return <><TextField onInput={(event) => setCount(Number(event.currentTarget.value))} /><input onInput={() => {}} /><Button onClick={() => setCount(count + 1)}>{count}</Button></>;",
        "}",
      ].join("\n"),
    },
  };

  const prepared = await preparePlaygroundBrowserExecution(plan);

  assert.equal(prepared.framework, "react");
  assert.match(prepared.rendererUrl, /^https:\/\/esm\.sh\/react@19\.2\.0/);
  assert.match(
    prepared.rendererDomClientUrl ?? "",
    /^https:\/\/esm\.sh\/react-dom@19\.2\.0\/client/,
  );
  assert.match(prepared.plan.source?.code ?? "", /from "react"/);
  assert.match(prepared.plan.source?.code ?? "", /react\/jsx-runtime/);
  assert.match(prepared.plan.source?.code ?? "", /onChange:/);
  assert.match(prepared.plan.source?.code ?? "", /onInput:/);
  assert.deepEqual(prepared.plan.imports, ["react", "@mui/material"]);
  assert.deepEqual(prepared.plan.capabilities?.allowedModules, [
    "react",
    "@mui/material",
  ]);
  const muiUrl =
    prepared.plan.moduleManifest?.["@mui/material"]?.resolvedUrl ?? "";
  assert.match(muiUrl, /^https:\/\/esm\.sh\/@mui\/material@9\.2\.0/);
  assert.match(muiUrl, /[?&]bundle(?:&|$)/);
  assert.match(muiUrl, /deps=react@19\.2\.0,react-dom@19\.2\.0/);
  assert.doesNotMatch(muiUrl, /alias=/);
});

test("playground browser client bundles as a self-contained global", async () => {
  const clientEntry = path.resolve(
    "packages/cli/src/playground-runtime-client.ts",
  );
  const code = await bundlePlaygroundRuntimeClient({
    clientEntry,
    resolveDir: process.cwd(),
  });

  assert.match(code, /RenderifyPlaygroundRuntime/);
  assert.match(code, /mount/);
  assert.match(code, /unmount/);
});
