import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeDiagnostic } from "../packages/ir/src/index";
import { resolveRuntimePlanImports } from "../packages/runtime/src/runtime-plan-imports";

test("runtime plan imports skip modules already owned by source code", async () => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const loaded: string[] = [];

  await resolveRuntimePlanImports({
    imports: ["@mui/material", "npm:side-effect"],
    sourceCode: [
      'import { Button } from "@mui/material";',
      "export default () => Button;",
    ].join("\n"),
    maxImports: 10,
    moduleManifest: undefined,
    diagnostics,
    moduleLoader: {
      async load(specifier: string): Promise<unknown> {
        loaded.push(specifier);
        return {};
      },
    },
    resolveRuntimeSpecifier: (specifier) => specifier,
    isResolvedSpecifierAllowed: () => true,
    isAborted: () => false,
    hasExceededBudget: () => false,
    withRemainingBudget: (operation) => operation(),
    isAbortError: () => false,
    errorToMessage: (error) => String(error),
  });

  assert.deepEqual(loaded, ["npm:side-effect"]);
  assert.deepEqual(diagnostics, []);
});
