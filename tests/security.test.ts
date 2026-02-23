import assert from "node:assert/strict";
import test from "node:test";
import {
  createComponentNode,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  DefaultSecurityChecker,
  getSecurityProfilePolicy,
  listSecurityProfiles,
} from "../packages/security/src/index";

function createPlan(rootTag = "section"): RuntimePlan & {
  capabilities: NonNullable<RuntimePlan["capabilities"]>;
} {
  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "plan_security_test",
    version: 1,
    root: createElementNode(rootTag, undefined, [createTextNode("content")]),
    capabilities: {
      domWrite: true,
    },
    imports: [],
  };
}

test("security checker blocks disallowed tags", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("script");
  const result = await checker.checkPlan(plan);

  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("Blocked tag detected")),
  );
  assert.ok(result.diagnostics.length > 0);
});

test("security checker blocks non-allowlisted network hosts", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.capabilities.networkHosts = ["evil.example.com"];

  const result = await checker.checkPlan(plan);

  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("Requested network host is not allowed"),
    ),
  );
});

test("security checker supports wildcard network host allowlists", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    overrides: {
      allowArbitraryNetwork: false,
      allowedNetworkHosts: ["*.jspm.io"],
    },
  });

  const allowedSubdomain = checker.checkModuleSpecifier(
    "https://ga.jspm.io/npm:lit@3.3.0/index.js",
  );
  const blockedRootDomain = checker.checkModuleSpecifier(
    "https://jspm.io/npm:lit@3.3.0/index.js",
  );

  assert.equal(allowedSubdomain.safe, true);
  assert.equal(blockedRootDomain.safe, false);
});

test("security checker normalizes default ports for allowed network hosts", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    overrides: {
      allowArbitraryNetwork: false,
      allowedNetworkHosts: ["ga.jspm.io"],
    },
  });

  const defaultPortAllowed = checker.checkModuleSpecifier(
    "https://ga.jspm.io:443/npm:lit@3.3.0/index.js",
  );
  const nonDefaultPortBlocked = checker.checkModuleSpecifier(
    "https://ga.jspm.io:444/npm:lit@3.3.0/index.js",
  );
  const protocolMismatchedPortBlocked = checker.checkModuleSpecifier(
    "https://ga.jspm.io:80/npm:lit@3.3.0/index.js",
  );
  const reverseProtocolMismatchedPortBlocked = checker.checkModuleSpecifier(
    "http://ga.jspm.io:443/npm:lit@3.3.0/index.js",
  );

  assert.equal(defaultPortAllowed.safe, true);
  assert.equal(nonDefaultPortBlocked.safe, false);
  assert.equal(protocolMismatchedPortBlocked.safe, false);
  assert.equal(reverseProtocolMismatchedPortBlocked.safe, false);
});

test("security checker allows allowed JSPM module specifiers", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const moduleResult = checker.checkModuleSpecifier("npm:lit@3.3.0");

  assert.equal(moduleResult.safe, true);
  assert.equal(moduleResult.issues.length, 0);
});

test("security checker blocks encoded path traversal module specifiers", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const encodedLowerResult = checker.checkModuleSpecifier(
    "https://ga.jspm.io/%2e%2e/escape.js",
  );
  const encodedUpperResult = checker.checkModuleSpecifier(
    "https://ga.jspm.io/%2E%2E/escape.js",
  );
  const doubleEncodedResult = checker.checkModuleSpecifier(
    "https://ga.jspm.io/%252e%252e/escape.js",
  );

  assert.equal(encodedLowerResult.safe, false);
  assert.equal(encodedUpperResult.safe, false);
  assert.equal(doubleEncodedResult.safe, false);
  assert.ok(
    encodedLowerResult.issues.some((issue) =>
      issue.includes("Path traversal is not allowed"),
    ),
  );
});

test("security checker blocks unsafe state action paths", async () => {
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

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("Unsafe action path")),
  );
});

test("security checker enforces capability quota limits", async () => {
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

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("maxImports")));
  assert.ok(result.issues.some((issue) => issue.includes("maxExecutionMs")));
  assert.ok(
    result.issues.some((issue) => issue.includes("maxComponentInvocations")),
  );
});

test("security checker allows vars.* action value references", async () => {
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

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true);
  assert.equal(result.issues.length, 0);
});

test("security checker supports profile initialization", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });

  const strictPolicy = checker.getPolicy();
  assert.equal(
    strictPolicy.maxTreeDepth,
    getSecurityProfilePolicy("strict").maxTreeDepth,
  );
  assert.equal(checker.getProfile(), "strict");
});

test("security checker precompiles source banned patterns on initialize", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    sourceBannedPatternStrings: ["\\beval\\s*\\(", "["],
  });

  const compiled = (
    checker as unknown as {
      sourceBannedPatterns?: Array<{ raw?: string }>;
    }
  ).sourceBannedPatterns;

  assert.deepEqual(
    (compiled ?? []).map((entry) => entry.raw),
    ["\\beval\\s*\\("],
  );
});

test("security profiles list includes strict balanced relaxed", async () => {
  const profiles = listSecurityProfiles();
  assert.deepEqual(profiles.sort(), ["balanced", "relaxed", "strict"]);
});

test("security checker validates requested execution profile", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    overrides: {
      allowedExecutionProfiles: ["standard"],
    },
  });

  const plan = createPlan("section");
  plan.capabilities.executionProfile = "isolated-vm";

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("executionProfile")));
});

test("security checker can disable runtime source modules via policy", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    allowRuntimeSourceModules: false,
  });

  const plan = createPlan("section");
  plan.source = {
    language: "tsx",
    code: "export default () => <section>hi</section>;",
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("Runtime source modules are disabled"),
    ),
  );
});

test("security checker requires moduleManifest for bare imports", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "plan_manifest_required",
    version: 1,
    root: createComponentNode("npm:acme/card"),
    capabilities: {
      domWrite: true,
    },
    imports: ["npm:acme/card"],
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("moduleManifest entry")),
  );
});

test("security checker requires moduleManifest for bare capability modules", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.capabilities.allowedModules = ["preact"];

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("moduleManifest entry")),
  );
});

test("security checker allows bare capability modules via moduleManifest", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.capabilities.allowedModules = ["preact", "recharts"];
  plan.moduleManifest = {
    preact: {
      resolvedUrl:
        "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
      signer: "tests",
    },
    recharts: {
      resolvedUrl: "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
      signer: "tests",
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true, result.issues.join("; "));
});

test("security checker strict profile requires integrity for remote modules", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });

  const plan = createPlan("section");
  plan.imports = ["npm:nanoid@5"];
  plan.moduleManifest = {
    "npm:nanoid@5": {
      resolvedUrl: "https://ga.jspm.io/npm/nanoid@5",
      signer: "tests",
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("requires integrity")),
  );
});

test("security checker allows internal inline runtime source specifiers without manifest entries", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "inline_source_specifier_plan",
    version: 1,
    root: createComponentNode("inline://todo-app-source"),
    capabilities: {
      domWrite: true,
      allowedModules: ["inline://todo-app-source"],
    },
    imports: ["inline://todo-app-source"],
    source: {
      language: "js",
      runtime: "renderify",
      code: 'export default () => ({ type: "text", value: "ok" });',
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true, result.issues.join("; "));
});

test("security checker allows internal synthetic source alias specifiers", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });

  const moduleResult = checker.checkModuleSpecifier("this-plan-source");
  assert.equal(moduleResult.safe, true);
  assert.equal(moduleResult.issues.length, 0);
});

test("security checker blocks banned runtime source patterns", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    code: [
      "export default () => {",
      '  eval("1+1");',
      '  return { type: "text", value: "ok" };',
      "};",
    ].join("\n"),
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("blocked pattern")));
});

test("security checker blocks runtime source fetch usage", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    code: [
      "export default async () => {",
      '  const response = await fetch("https://example.com/data.json");',
      '  return { type: "text", value: String(response.status) };',
      "};",
    ].join("\n"),
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((issue) => issue.includes("\\bfetch\\s*\\(")));
});

test("security checker blocks runtime source cookie access", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    code: [
      "export default () => {",
      "  const token = document.cookie;",
      '  return { type: "text", value: token };',
      "};",
    ].join("\n"),
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("\\bdocument\\s*\\.\\s*cookie\\b"),
    ),
  );
});
