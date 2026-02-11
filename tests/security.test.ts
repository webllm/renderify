import assert from "node:assert/strict";
import test from "node:test";
import { createElementNode, createTextNode, type RuntimePlan } from "../packages/ir/src/index";
import {
  DefaultSecurityChecker,
  getSecurityProfilePolicy,
  listSecurityProfiles,
} from "../packages/security/src/index";

function createPlan(rootTag = "section"): RuntimePlan {
  return {
    id: "plan_security_test",
    version: 1,
    root: createElementNode(rootTag, undefined, [createTextNode("content")]),
    capabilities: {
      domWrite: true,
    },
    imports: [],
  };
}

test("security checker blocks disallowed tags", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("script");
  const result = checker.checkPlan(plan);

  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("Blocked tag detected")));
  assert.ok(result.diagnostics.length > 0);
});

test("security checker blocks non-allowlisted network hosts", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.capabilities.networkHosts = ["evil.example.com"];

  const result = checker.checkPlan(plan);

  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("Requested network host is not allowed")
    )
  );
});

test("security checker allows allowed JSPM module specifiers", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const moduleResult = checker.checkModuleSpecifier("npm:lit@3.3.0");

  assert.equal(moduleResult.safe, true);
  assert.equal(moduleResult.issues.length, 0);
});

test("security checker blocks unsafe state action paths", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.state = {
    initial: {
      count: 0,
    },
    transitions: {
      hack: [
        {
          type: "set",
          path: "__proto__.polluted",
          value: 1,
        },
      ],
    },
  };

  const result = checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("Unsafe action path")));
});

test("security checker enforces capability quota limits", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    maxAllowedImports: 2,
    maxAllowedExecutionMs: 50,
    maxAllowedComponentInvocations: 1,
  });

  const plan = createPlan("section");
  plan.capabilities.maxImports = 5;
  plan.capabilities.maxExecutionMs = 100;
  plan.capabilities.maxComponentInvocations = 9;

  const result = checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("maxImports")));
  assert.ok(result.issues.some((issue) => issue.includes("maxExecutionMs")));
  assert.ok(
    result.issues.some((issue) => issue.includes("maxComponentInvocations"))
  );
});

test("security checker allows vars.* action value references", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.state = {
    initial: {
      value: 0,
    },
    transitions: {
      copyFromVars: [
        {
          type: "set",
          path: "value",
          value: { $from: "vars.counter" },
        },
      ],
    },
  };

  const result = checker.checkPlan(plan);
  assert.equal(result.safe, true);
  assert.equal(result.issues.length, 0);
});

test("security checker supports profile initialization", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });

  const strictPolicy = checker.getPolicy();
  assert.equal(strictPolicy.maxTreeDepth, getSecurityProfilePolicy("strict").maxTreeDepth);
  assert.equal(checker.getProfile(), "strict");
});

test("security profiles list includes strict balanced relaxed", () => {
  const profiles = listSecurityProfiles();
  assert.deepEqual(profiles.sort(), ["balanced", "relaxed", "strict"]);
});

test("security checker validates requested execution profile", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    overrides: {
      allowedExecutionProfiles: ["standard"],
    },
  });

  const plan = createPlan("section");
  plan.capabilities.executionProfile = "isolated-vm";

  const result = checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("executionProfile"))
  );
});

test("security checker can disable runtime source modules via policy", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    allowRuntimeSourceModules: false,
  });

  const plan = createPlan("section");
  plan.source = {
    language: "tsx",
    code: "export default () => <section>hi</section>;",
  };

  const result = checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("Runtime source modules are disabled")
    )
  );
});
