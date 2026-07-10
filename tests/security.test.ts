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

const REMOTE_MODULE_URL =
  "https://ga.jspm.io/npm:nanoid@5.1.6/index.browser.js";
const VALID_SHA384_INTEGRITY = `sha384-${"A".repeat(64)}`;

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

test("security checker fail-closed rejects malformed plan payloads", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const result = await checker.checkPlan({} as RuntimePlan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("not a valid RuntimePlan")),
  );
  assert.ok(
    result.diagnostics.some((item) => item.code === "SECURITY_PLAN_INVALID"),
  );
});

test("security checker fail-closed rejects malformed module manifests", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize();

  const plan = createPlan("section");
  (plan as unknown as { moduleManifest?: unknown }).moduleManifest = {
    "npm:demo": {},
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.diagnostics.some((item) => item.code === "SECURITY_PLAN_INVALID"),
  );
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

test("security checker applies network policy to declarative UI URLs", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    overrides: {
      allowArbitraryNetwork: false,
      allowedNetworkHosts: ["assets.example.com"],
    },
  });

  const blockedPlan = createPlan("section");
  blockedPlan.root = createElementNode("img", {
    src: "https://evil.example.com/collect",
    srcSet:
      "https://assets.example.com/image.png 1x, //evil.example.com/image.png 2x",
    filter: "url(https://evil.example.com/filter.svg#blur)",
  });
  const blocked = await checker.checkPlan(blockedPlan);

  assert.equal(blocked.safe, false);
  assert.ok(
    blocked.issues.some((issue) =>
      issue.includes("Network host is not in allowlist for <img> src"),
    ),
  );
  assert.ok(
    blocked.issues.some((issue) =>
      issue.includes("Network host is not in allowlist for <img> srcSet"),
    ),
  );
  assert.ok(
    blocked.issues.some((issue) =>
      issue.includes("Network host is not in allowlist for <img> filter"),
    ),
  );

  const allowedPlan = createPlan("section");
  allowedPlan.root = createElementNode("section", undefined, [
    createElementNode("img", {
      src: "https://assets.example.com/image.png",
      srcSet: "/image.png 1x, ../image@2x.png 2x",
    }),
    createElementNode("a", { href: "mailto:support@example.com" }, [
      createTextNode("Support"),
    ]),
  ]);
  const allowed = await checker.checkPlan(allowedPlan);

  assert.equal(allowed.safe, true, allowed.issues.join("; "));
});

test("security checker rejects dangerous UI URL protocols in relaxed mode", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "relaxed" });
  const plan = createPlan("section");
  plan.root = createElementNode("section", undefined, [
    createElementNode("img", {
      src: "data:image/svg+xml,<svg onload=alert(1)>",
    }),
    createElementNode("a", { href: "java\nscript:alert(1)" }, [
      createTextNode("unsafe"),
    ]),
    createElementNode("svg", {
      fill: "u\\72l(data:image/svg+xml,<svg onload=alert(1)>)",
    }),
    createElementNode("img", { src: "mailto:leak@example.com" }),
  ]);

  const result = await checker.checkPlan(plan);

  assert.equal(result.safe, false);
  assert.equal(
    result.issues.filter((issue) => issue.includes("Unsafe URL value")).length,
    4,
  );
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

test("security checker rejects module manifests larger than the import policy", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    maxAllowedImports: 2,
  });

  const plan = createPlan("section");
  plan.moduleManifest = {
    first: { resolvedUrl: "npm:first", signer: "tests" },
    second: { resolvedUrl: "npm:second", signer: "tests" },
    third: { resolvedUrl: "npm:third", signer: "tests" },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.includes(
      "moduleManifest entry count 3 exceeds policy limit 2",
    ),
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

test("security profile policies return detached array snapshots", () => {
  const first = getSecurityProfilePolicy("strict");
  const second = getSecurityProfilePolicy("strict");
  const expectedSecond = JSON.stringify(second);

  first.blockedTags.push("section");
  first.allowedModules.push("unsafe-module");
  first.allowedNetworkHosts.push("evil.example.com");
  first.allowedExecutionProfiles.splice(0);
  first.supportedSpecVersions.push("unsafe-version");
  first.sourceBannedPatternStrings.splice(0);

  assert.equal(JSON.stringify(second), expectedSecond);
});

test("security checker detaches initialized policy arrays from callers", () => {
  const blockedTags = ["script"];
  const allowedModules = ["npm:"];
  const allowedNetworkHosts = ["ga.jspm.io"];
  const allowedExecutionProfiles: Array<"standard" | "isolated-vm"> = [
    "standard",
  ];
  const supportedSpecVersions = [DEFAULT_RUNTIME_PLAN_SPEC_VERSION];
  const sourceBannedPatternStrings = ["\\beval\\s*\\("];
  const checker = new DefaultSecurityChecker();

  checker.initialize({
    overrides: {
      blockedTags,
      allowedModules,
      allowedNetworkHosts,
      allowedExecutionProfiles,
      supportedSpecVersions,
      sourceBannedPatternStrings,
    },
  });

  blockedTags.push("section");
  allowedModules.push("unsafe-module");
  allowedNetworkHosts.push("evil.example.com");
  allowedExecutionProfiles.push("isolated-vm");
  supportedSpecVersions.push("unsafe-version");
  sourceBannedPatternStrings.splice(0);

  const policy = checker.getPolicy();
  assert.deepEqual(policy.blockedTags, ["script"]);
  assert.deepEqual(policy.allowedModules, ["npm:"]);
  assert.deepEqual(policy.allowedNetworkHosts, ["ga.jspm.io"]);
  assert.deepEqual(policy.allowedExecutionProfiles, ["standard"]);
  assert.deepEqual(policy.supportedSpecVersions, [
    DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  ]);
  assert.deepEqual(policy.sourceBannedPatternStrings, ["\\beval\\s*\\("]);
});

test("security checker returns detached policy array snapshots", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });
  const expected = getSecurityProfilePolicy("strict");
  const snapshot = checker.getPolicy();

  snapshot.blockedTags.push("section");
  snapshot.allowedModules.push("unsafe-module");
  snapshot.allowedNetworkHosts.push("evil.example.com");
  snapshot.allowedExecutionProfiles.splice(0);
  snapshot.supportedSpecVersions.push("unsafe-version");
  snapshot.sourceBannedPatternStrings.splice(0);

  assert.deepEqual(checker.getPolicy(), expected);
});

test("security checker precompiles source banned patterns on initialize", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    sourceBannedPatternStrings: ["\\beval\\s*\\(", "\\bfetch\\s*\\("],
  });

  const compiled = (
    checker as unknown as {
      sourceBannedPatterns?: Array<{ raw?: string }>;
    }
  ).sourceBannedPatterns;

  assert.deepEqual(
    (compiled ?? []).map((entry) => entry.raw),
    ["\\beval\\s*\\(", "\\bfetch\\s*\\("],
  );
});

test("security checker rejects invalid source patterns atomically", () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });
  const previousPolicy = checker.getPolicy();

  assert.throws(
    () =>
      checker.initialize({
        profile: "relaxed",
        overrides: {
          sourceBannedPatternStrings: ["["],
        },
      }),
    /Invalid source banned pattern "\["/,
  );

  assert.equal(checker.getProfile(), "strict");
  assert.deepEqual(checker.getPolicy(), previousPolicy);
});

test("security profiles list includes strict balanced trusted relaxed", async () => {
  const profiles = listSecurityProfiles();
  assert.deepEqual(profiles.sort(), [
    "balanced",
    "relaxed",
    "strict",
    "trusted",
  ]);
});

test("trusted profile enables preact without relaxed network permissions", async () => {
  const trustedPolicy = getSecurityProfilePolicy("trusted");
  assert.equal(trustedPolicy.allowRuntimeSourceModules, true);
  assert.equal(trustedPolicy.allowPreactSourceRuntime, true);
  assert.equal(trustedPolicy.allowArbitraryNetwork, false);
  assert.equal(trustedPolicy.allowDynamicSourceImports, false);
  assert.equal(trustedPolicy.requireModuleManifestForBareSpecifiers, true);
});

test("strict and balanced profiles disable runtime source modules", () => {
  assert.equal(
    getSecurityProfilePolicy("strict").allowRuntimeSourceModules,
    false,
  );
  assert.equal(
    getSecurityProfilePolicy("balanced").allowRuntimeSourceModules,
    false,
  );
  assert.equal(
    getSecurityProfilePolicy("relaxed").allowRuntimeSourceModules,
    true,
  );
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

test("security checker blocks preact when balanced source is explicitly enabled", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({
    profile: "balanced",
    overrides: {
      allowRuntimeSourceModules: true,
    },
  });

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    runtime: "preact",
    code: "export default function View(){ return null; }",
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("source.runtime=preact")),
  );
  assert.ok(
    result.issues.some((issue) => issue.includes("trusted or relaxed")),
  );
});

test("security checker allows source.runtime=preact in relaxed profile", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "relaxed" });

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    runtime: "preact",
    code: "export default function View(){ return null; }",
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true, result.issues.join("; "));
});

test("security checker allows source.runtime=preact in trusted profile", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "trusted" });

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    runtime: "preact",
    code: "export default function View(){ return null; }",
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true, result.issues.join("; "));
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

test("strict integrity policy requires manifests for every direct remote module reference", async () => {
  const cases: Array<{
    name: string;
    apply: (plan: ReturnType<typeof createPlan>) => void;
  }> = [
    {
      name: "plan import",
      apply: (plan) => {
        plan.imports = [REMOTE_MODULE_URL];
      },
    },
    {
      name: "component",
      apply: (plan) => {
        plan.root = createComponentNode(REMOTE_MODULE_URL);
      },
    },
    {
      name: "capability",
      apply: (plan) => {
        plan.capabilities.allowedModules = [REMOTE_MODULE_URL];
      },
    },
    {
      name: "source import",
      apply: (plan) => {
        plan.source = {
          language: "js",
          code: `import value from ${JSON.stringify(REMOTE_MODULE_URL)}; export default value;`,
        };
      },
    },
  ];

  for (const testCase of cases) {
    const checker = new DefaultSecurityChecker();
    checker.initialize({
      profile: "strict",
      overrides: {
        allowRuntimeSourceModules: true,
      },
    });
    const plan = createPlan("section");
    testCase.apply(plan);

    const result = await checker.checkPlan(plan);
    assert.equal(result.safe, false, testCase.name);
    assert.ok(
      result.issues.some((issue) =>
        issue.includes(
          "Missing moduleManifest entry required for remote module integrity",
        ),
      ),
      testCase.name,
    );
  }
});

test("strict integrity policy rejects mismatched direct remote manifest targets", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });
  const plan = createPlan("section");
  plan.imports = [REMOTE_MODULE_URL];
  plan.moduleManifest = {
    [REMOTE_MODULE_URL]: {
      resolvedUrl: "https://ga.jspm.io/npm:nanoid@5.1.5/index.browser.js",
      integrity: VALID_SHA384_INTEGRITY,
      signer: "tests",
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes(
        "moduleManifest resolvedUrl does not match direct remote module reference",
      ),
    ),
  );
});

test("strict integrity policy rejects unsupported integrity formats", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });
  const plan = createPlan("section");
  plan.imports = [REMOTE_MODULE_URL];
  plan.moduleManifest = {
    [REMOTE_MODULE_URL]: {
      resolvedUrl: REMOTE_MODULE_URL,
      integrity: "sha384-not-a-complete-digest",
      signer: "tests",
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("unsupported integrity format"),
    ),
  );
});

test("strict integrity policy accepts a covered direct remote module", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "strict" });
  const plan = createPlan("section");
  plan.imports = [REMOTE_MODULE_URL];
  plan.moduleManifest = {
    [REMOTE_MODULE_URL]: {
      resolvedUrl: REMOTE_MODULE_URL,
      integrity: VALID_SHA384_INTEGRITY,
      signer: "tests",
    },
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, true, result.issues.join("; "));
});

test("security checker allows internal inline runtime source specifiers without manifest entries", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "trusted" });

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
  checker.initialize({ profile: "trusted" });

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
  checker.initialize({ profile: "trusted" });

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

test("security checker blocks obfuscated runtime source fetch access", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "trusted" });

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    code: [
      "export default async () => {",
      '  const fetcher = globalThis["fet" + "ch"];',
      '  const response = await fetcher("https://example.com/data.json");',
      '  return { type: "text", value: String(response.status) };',
      "};",
    ].join("\n"),
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("blocked global access: fetch"),
    ),
  );
});

test("security checker blocks runtime source cookie access", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "trusted" });

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

test("security checker blocks obfuscated runtime source cookie access", async () => {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: "trusted" });

  const plan = createPlan("section");
  plan.source = {
    language: "js",
    code: [
      "export default () => {",
      '  const token = document["coo" + "kie"];',
      '  return { type: "text", value: token };',
      "};",
    ].join("\n"),
  };

  const result = await checker.checkPlan(plan);
  assert.equal(result.safe, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("blocked global access: document.cookie"),
    ),
  );
});
