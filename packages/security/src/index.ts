import {
  collectRuntimeSourceImports,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  isAllowedNetworkUrl,
  isAllowedRequestedNetworkHost,
  isRuntimePlan,
  isRuntimeValueFromPath,
  isSafePath,
  parseRuntimeEventBinding,
  type RuntimeAction,
  type RuntimeCapabilities,
  type RuntimeDiagnostic,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimeSourceModule,
  type RuntimeStateModel,
  resolveRuntimePlanSpecVersion,
} from "@renderify/ir";

export interface SecurityCheckResult {
  safe: boolean;
  issues: string[];
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeUrlAttributeInspection {
  safe: boolean;
  remoteUrls: URL[];
  relativeUrls?: string[];
  nonNetworkProtocolUrls?: string[];
}

export interface RuntimeSecurityPolicy {
  blockedTags: string[];
  maxTreeDepth: number;
  maxNodeCount: number;
  allowInlineEventHandlers: boolean;
  allowedModules: string[];
  allowedNetworkHosts: string[];
  allowArbitraryNetwork: boolean;
  allowedExecutionProfiles: Array<
    | "standard"
    | "isolated-vm"
    | "sandbox-worker"
    | "sandbox-iframe"
    | "sandbox-shadowrealm"
  >;
  maxTransitionsPerPlan: number;
  maxActionsPerTransition: number;
  maxAllowedImports: number;
  maxAllowedExecutionMs: number;
  maxAllowedComponentInvocations: number;
  allowRuntimeSourceModules: boolean;
  allowPreactSourceRuntime: boolean;
  maxRuntimeSourceBytes: number;
  supportedSpecVersions: string[];
  requireSpecVersion: boolean;
  requireModuleManifestForBareSpecifiers: boolean;
  requireModuleIntegrity: boolean;
  allowDynamicSourceImports: boolean;
  sourceBannedPatternStrings: string[];
  maxSourceImportSpecifiers: number;
}

export type RuntimeSecurityProfile =
  | "strict"
  | "balanced"
  | "trusted"
  | "relaxed";

export interface SecurityInitializationOptions {
  profile?: RuntimeSecurityProfile;
  overrides?: Partial<RuntimeSecurityPolicy>;
}

export type SecurityInitializationInput =
  | Partial<RuntimeSecurityPolicy>
  | SecurityInitializationOptions
  | undefined;

export interface SecurityChecker {
  initialize(input?: SecurityInitializationInput): void;
  getPolicy(): RuntimeSecurityPolicy;
  getProfile(): RuntimeSecurityProfile;
  checkPlan(plan: RuntimePlan): Promise<SecurityCheckResult>;
  checkModuleSpecifier(specifier: string): SecurityCheckResult;
  checkCapabilities(
    capabilities: RuntimeCapabilities,
    moduleManifest?: RuntimeModuleManifest,
  ): SecurityCheckResult;
}

const SECURITY_PROFILE_POLICIES: Record<
  RuntimeSecurityProfile,
  RuntimeSecurityPolicy
> = {
  strict: {
    blockedTags: ["script", "iframe", "object", "embed", "link", "meta"],
    maxTreeDepth: 8,
    maxNodeCount: 250,
    allowInlineEventHandlers: false,
    allowedModules: ["/", "npm:"],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
    allowArbitraryNetwork: false,
    allowedExecutionProfiles: [
      "standard",
      "isolated-vm",
      "sandbox-worker",
      "sandbox-iframe",
      "sandbox-shadowrealm",
    ],
    maxTransitionsPerPlan: 40,
    maxActionsPerTransition: 20,
    maxAllowedImports: 80,
    maxAllowedExecutionMs: 5000,
    maxAllowedComponentInvocations: 120,
    allowRuntimeSourceModules: false,
    allowPreactSourceRuntime: false,
    maxRuntimeSourceBytes: 20000,
    supportedSpecVersions: [DEFAULT_RUNTIME_PLAN_SPEC_VERSION],
    requireSpecVersion: true,
    requireModuleManifestForBareSpecifiers: true,
    requireModuleIntegrity: true,
    allowDynamicSourceImports: false,
    sourceBannedPatternStrings: [
      "\\beval\\s*\\(",
      "\\bnew\\s+Function\\b",
      "\\bfetch\\s*\\(",
      "\\bXMLHttpRequest\\b",
      "\\bWebSocket\\b",
      "\\bimportScripts\\b",
      "\\bdocument\\s*\\.\\s*cookie\\b",
      "\\blocalStorage\\b",
      "\\bsessionStorage\\b",
      "\\bindexedDB\\b",
      "\\bnavigator\\s*\\.\\s*sendBeacon\\b",
      "\\bchild_process\\b",
      "\\bprocess\\s*\\.\\s*env\\b",
    ],
    maxSourceImportSpecifiers: 30,
  },
  balanced: {
    blockedTags: ["script", "iframe", "object", "embed", "link", "meta"],
    maxTreeDepth: 12,
    maxNodeCount: 500,
    allowInlineEventHandlers: false,
    allowedModules: ["/", "npm:"],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
    allowArbitraryNetwork: false,
    allowedExecutionProfiles: [
      "standard",
      "isolated-vm",
      "sandbox-worker",
      "sandbox-iframe",
      "sandbox-shadowrealm",
    ],
    maxTransitionsPerPlan: 100,
    maxActionsPerTransition: 50,
    maxAllowedImports: 200,
    maxAllowedExecutionMs: 15000,
    maxAllowedComponentInvocations: 500,
    allowRuntimeSourceModules: false,
    allowPreactSourceRuntime: false,
    maxRuntimeSourceBytes: 80000,
    supportedSpecVersions: [DEFAULT_RUNTIME_PLAN_SPEC_VERSION],
    requireSpecVersion: true,
    requireModuleManifestForBareSpecifiers: true,
    requireModuleIntegrity: false,
    allowDynamicSourceImports: false,
    sourceBannedPatternStrings: [
      "\\beval\\s*\\(",
      "\\bnew\\s+Function\\b",
      "\\bfetch\\s*\\(",
      "\\bXMLHttpRequest\\b",
      "\\bWebSocket\\b",
      "\\bimportScripts\\b",
      "\\bdocument\\s*\\.\\s*cookie\\b",
      "\\blocalStorage\\b",
      "\\bsessionStorage\\b",
      "\\bchild_process\\b",
    ],
    maxSourceImportSpecifiers: 120,
  },
  trusted: {
    blockedTags: ["script", "iframe", "object", "embed", "link", "meta"],
    maxTreeDepth: 16,
    maxNodeCount: 1000,
    allowInlineEventHandlers: false,
    allowedModules: ["/", "npm:"],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io", "esm.sh"],
    allowArbitraryNetwork: false,
    allowedExecutionProfiles: [
      "standard",
      "isolated-vm",
      "sandbox-worker",
      "sandbox-iframe",
      "sandbox-shadowrealm",
    ],
    maxTransitionsPerPlan: 150,
    maxActionsPerTransition: 75,
    maxAllowedImports: 400,
    maxAllowedExecutionMs: 30000,
    maxAllowedComponentInvocations: 1000,
    allowRuntimeSourceModules: true,
    allowPreactSourceRuntime: true,
    maxRuntimeSourceBytes: 120000,
    supportedSpecVersions: [DEFAULT_RUNTIME_PLAN_SPEC_VERSION],
    requireSpecVersion: true,
    requireModuleManifestForBareSpecifiers: true,
    requireModuleIntegrity: false,
    allowDynamicSourceImports: false,
    sourceBannedPatternStrings: [
      "\\beval\\s*\\(",
      "\\bnew\\s+Function\\b",
      "\\bfetch\\s*\\(",
      "\\bXMLHttpRequest\\b",
      "\\bWebSocket\\b",
      "\\bimportScripts\\b",
      "\\bdocument\\s*\\.\\s*cookie\\b",
      "\\blocalStorage\\b",
      "\\bsessionStorage\\b",
      "\\bchild_process\\b",
    ],
    maxSourceImportSpecifiers: 180,
  },
  relaxed: {
    blockedTags: ["script", "iframe", "object", "embed"],
    maxTreeDepth: 24,
    maxNodeCount: 2000,
    allowInlineEventHandlers: true,
    allowedModules: [
      "/",
      "npm:",
      "https://ga.jspm.io/",
      "https://cdn.jspm.io/",
    ],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io", "esm.sh", "unpkg.com"],
    allowArbitraryNetwork: true,
    allowedExecutionProfiles: [
      "standard",
      "isolated-vm",
      "sandbox-worker",
      "sandbox-iframe",
      "sandbox-shadowrealm",
    ],
    maxTransitionsPerPlan: 400,
    maxActionsPerTransition: 150,
    maxAllowedImports: 1000,
    maxAllowedExecutionMs: 60000,
    maxAllowedComponentInvocations: 4000,
    allowRuntimeSourceModules: true,
    allowPreactSourceRuntime: true,
    maxRuntimeSourceBytes: 200000,
    supportedSpecVersions: [DEFAULT_RUNTIME_PLAN_SPEC_VERSION],
    requireSpecVersion: false,
    requireModuleManifestForBareSpecifiers: false,
    requireModuleIntegrity: false,
    allowDynamicSourceImports: true,
    sourceBannedPatternStrings: ["\\bchild_process\\b"],
    maxSourceImportSpecifiers: 500,
  },
};

const DEFAULT_SECURITY_PROFILE: RuntimeSecurityProfile = "balanced";
const INTERNAL_RUNTIME_SOURCE_MODULE_SPECIFIERS = new Set(["this-plan-source"]);
const SINGLE_RUNTIME_URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "background",
  "cite",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "longdesc",
  "lowsrc",
  "manifest",
  "poster",
  "profile",
  "src",
  "usemap",
  "xlink:href",
  "xlinkhref",
  "xml:base",
  "xmlbase",
]);
const LIST_RUNTIME_URL_ATTRIBUTE_NAMES = new Set([
  "archive",
  "attributionsrc",
  "ping",
]);
const SOURCE_SET_RUNTIME_URL_ATTRIBUTE_NAMES = new Set([
  "imagesrcset",
  "srcset",
]);
const FUNCTIONAL_IRI_RUNTIME_ATTRIBUTE_NAMES = new Set([
  "clip-path",
  "clippath",
  "cursor",
  "fill",
  "filter",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerend",
  "markermid",
  "markerstart",
  "mask",
  "shape-inside",
  "shape-outside",
  "stroke",
]);
const CSS_IMAGE_SET_FUNCTION_PATTERN =
  /(?:^|[^a-z0-9_-])(?:-webkit-)?image-set\s*\(/i;
const SAFE_NON_NETWORK_URL_PROTOCOLS = new Set(["mailto:", "tel:"]);
const SAFE_NON_NETWORK_PROTOCOL_ATTRIBUTE_NAMES = new Set([
  "href",
  "xlink:href",
  "xlinkhref",
]);
const SOURCE_GLOBAL_OBJECTS = ["globalThis", "self", "window"];
const SOURCE_BANNED_GLOBAL_PROPERTIES = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
  "localStorage",
  "sessionStorage",
  "indexedDB",
];
const SOURCE_BANNED_QUALIFIED_PROPERTIES = [
  { object: "document", property: "cookie" },
  { object: "navigator", property: "sendBeacon" },
  { object: "process", property: "env" },
];

export function listSecurityProfiles(): RuntimeSecurityProfile[] {
  return Object.keys(SECURITY_PROFILE_POLICIES) as RuntimeSecurityProfile[];
}

export function getSecurityProfilePolicy(
  profile: RuntimeSecurityProfile,
): RuntimeSecurityPolicy {
  return clonePolicy(SECURITY_PROFILE_POLICIES[profile]);
}

export function isRuntimeUrlAttribute(attributeName: string): boolean {
  const normalized = attributeName.toLowerCase();
  return (
    SINGLE_RUNTIME_URL_ATTRIBUTE_NAMES.has(normalized) ||
    LIST_RUNTIME_URL_ATTRIBUTE_NAMES.has(normalized) ||
    SOURCE_SET_RUNTIME_URL_ATTRIBUTE_NAMES.has(normalized) ||
    FUNCTIONAL_IRI_RUNTIME_ATTRIBUTE_NAMES.has(normalized)
  );
}

export function hasRuntimeCssImageSetFunction(value: string): boolean {
  return CSS_IMAGE_SET_FUNCTION_PATTERN.test(
    normalizeCssForUrlSecurityInspection(value),
  );
}

export function inspectRuntimeUrlAttribute(
  attributeName: string,
  value: string,
): RuntimeUrlAttributeInspection {
  const normalized = attributeName.toLowerCase();
  const references = splitRuntimeUrlAttributeValue(normalized, value);
  if (!references) {
    return {
      safe: false,
      remoteUrls: [],
      relativeUrls: [],
      nonNetworkProtocolUrls: [],
    };
  }

  const remoteUrls: URL[] = [];
  const relativeUrls: string[] = [];
  const nonNetworkProtocolUrls: string[] = [];
  for (const reference of references) {
    const inspected = inspectRuntimeUrlReference(
      reference,
      SAFE_NON_NETWORK_PROTOCOL_ATTRIBUTE_NAMES.has(normalized),
    );
    if (!inspected.safe) {
      return {
        safe: false,
        remoteUrls: [],
        relativeUrls: [],
        nonNetworkProtocolUrls: [],
      };
    }
    if (inspected.remoteUrl) {
      remoteUrls.push(inspected.remoteUrl);
    }
    if (inspected.relativeUrl) {
      relativeUrls.push(inspected.relativeUrl);
    }
    if (inspected.nonNetworkProtocolUrl) {
      nonNetworkProtocolUrls.push(inspected.nonNetworkProtocolUrl);
    }
  }

  return {
    safe: true,
    remoteUrls,
    relativeUrls,
    nonNetworkProtocolUrls,
  };
}

export class DefaultSecurityChecker implements SecurityChecker {
  private policy: RuntimeSecurityPolicy = getSecurityProfilePolicy(
    DEFAULT_SECURITY_PROFILE,
  );
  private sourceBannedPatterns: Array<{
    raw: string;
    regex: RegExp;
  }> = compileSourceBannedPatterns(this.policy.sourceBannedPatternStrings);
  private profile: RuntimeSecurityProfile = DEFAULT_SECURITY_PROFILE;

  initialize(input?: SecurityInitializationInput): void {
    const normalized = normalizeInitializationInput(input);
    const profile = normalized.profile ?? DEFAULT_SECURITY_PROFILE;
    const basePolicy = getSecurityProfilePolicy(profile);

    const nextPolicy = clonePolicy({
      ...basePolicy,
      ...normalized.overrides,
      blockedTags: normalized.overrides?.blockedTags ?? basePolicy.blockedTags,
      allowedModules:
        normalized.overrides?.allowedModules ?? basePolicy.allowedModules,
      allowedNetworkHosts:
        normalized.overrides?.allowedNetworkHosts ??
        basePolicy.allowedNetworkHosts,
      allowedExecutionProfiles:
        normalized.overrides?.allowedExecutionProfiles ??
        basePolicy.allowedExecutionProfiles,
      supportedSpecVersions:
        normalized.overrides?.supportedSpecVersions ??
        basePolicy.supportedSpecVersions,
      sourceBannedPatternStrings:
        normalized.overrides?.sourceBannedPatternStrings ??
        basePolicy.sourceBannedPatternStrings,
    });
    const nextSourceBannedPatterns = compileSourceBannedPatterns(
      nextPolicy.sourceBannedPatternStrings,
    );

    this.policy = nextPolicy;
    this.sourceBannedPatterns = nextSourceBannedPatterns;
    this.profile = profile;
  }

  getPolicy(): RuntimeSecurityPolicy {
    return clonePolicy(this.policy);
  }

  getProfile(): RuntimeSecurityProfile {
    return this.profile;
  }

  async checkPlan(plan: RuntimePlan): Promise<SecurityCheckResult> {
    if (!isRuntimePlan(plan)) {
      return {
        safe: false,
        issues: ["Runtime plan payload is not a valid RuntimePlan object"],
        diagnostics: [
          {
            level: "error",
            code: "SECURITY_PLAN_INVALID",
            message: "Runtime plan payload is not a valid RuntimePlan object",
          },
        ],
      };
    }

    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];
    try {
      const planSpecVersion = resolveRuntimePlanSpecVersion(plan.specVersion);
      const moduleManifest = plan.moduleManifest;

      if (
        this.policy.requireSpecVersion &&
        (typeof plan.specVersion !== "string" ||
          plan.specVersion.trim().length === 0)
      ) {
        issues.push("Runtime plan specVersion is required by policy");
      }

      if (!this.policy.supportedSpecVersions.includes(planSpecVersion)) {
        issues.push(
          `Runtime plan specVersion ${planSpecVersion} is not supported by policy`,
        );
      }

      if (moduleManifest) {
        issues.push(...this.checkModuleManifest(moduleManifest));
      }

      if (
        this.policy.requireModuleManifestForBareSpecifiers ||
        this.policy.requireModuleIntegrity
      ) {
        issues.push(
          ...(await this.checkManifestCoverage(plan, moduleManifest)),
        );
      }

      const capabilityResult = this.checkCapabilities(
        plan.capabilities ?? {},
        moduleManifest,
      );
      issues.push(...capabilityResult.issues);
      diagnostics.push(...capabilityResult.diagnostics);

      let nodeCount = 0;

      const walk = (node: RuntimeNode, depth: number) => {
        nodeCount += 1;

        if (depth > this.policy.maxTreeDepth) {
          issues.push(
            `Node depth ${depth} exceeds maximum ${this.policy.maxTreeDepth}`,
          );
        }

        if (node.type === "element") {
          const normalizedTag = node.tag.toLowerCase();
          if (this.policy.blockedTags.includes(normalizedTag)) {
            issues.push(`Blocked tag detected: <${normalizedTag}>`);
          }

          if (node.props) {
            for (const [key, value] of Object.entries(node.props)) {
              if (
                !this.policy.allowInlineEventHandlers &&
                key.toLowerCase().startsWith("on") &&
                !parseRuntimeEventBinding(key, value)
              ) {
                issues.push(`Inline event handler is not allowed: ${key}`);
              }

              if (!isRuntimeUrlAttribute(key) || typeof value !== "string") {
                continue;
              }

              const inspection = inspectRuntimeUrlAttribute(key, value);
              if (!inspection.safe) {
                issues.push(
                  `Unsafe URL value in <${normalizedTag}> ${key} attribute`,
                );
                continue;
              }

              if (this.policy.allowArbitraryNetwork) {
                continue;
              }

              for (const remoteUrl of inspection.remoteUrls) {
                if (
                  !isAllowedNetworkUrl(
                    remoteUrl,
                    this.policy.allowedNetworkHosts,
                  )
                ) {
                  issues.push(
                    `Network host is not in allowlist for <${normalizedTag}> ${key}: ${remoteUrl.host}`,
                  );
                }
              }
            }
          }
        }

        if (node.type === "component") {
          const componentSpecifier = this.resolveManifestSpecifier(
            node.module,
            moduleManifest,
          );
          const componentResult = this.checkModuleSpecifier(componentSpecifier);
          issues.push(...componentResult.issues);
        }

        if (node.type === "text") {
          return;
        }

        for (const child of node.children ?? []) {
          walk(child, depth + 1);
        }
      };

      walk(plan.root, 0);

      if (nodeCount > this.policy.maxNodeCount) {
        issues.push(
          `Node count ${nodeCount} exceeds maximum ${this.policy.maxNodeCount}`,
        );
      }

      const importSpecifiers = plan.imports ?? [];
      for (const specifier of importSpecifiers) {
        const effectiveSpecifier = this.resolveManifestSpecifier(
          specifier,
          moduleManifest,
        );
        const importCheck = this.checkModuleSpecifier(effectiveSpecifier);
        issues.push(...importCheck.issues);
      }

      if (plan.state) {
        issues.push(...this.checkStateModel(plan.state));
      }

      if (plan.source) {
        issues.push(
          ...(await this.checkRuntimeSource(plan.source, moduleManifest)),
        );
      }
    } catch (error) {
      const message = this.errorToMessage(error);
      return {
        safe: false,
        issues: [`Security checker failed to evaluate plan: ${message}`],
        diagnostics: [
          {
            level: "error",
            code: "SECURITY_CHECK_FAILED",
            message,
          },
        ],
      };
    }

    for (const issue of issues) {
      diagnostics.push({
        level: "error",
        code: "SECURITY_POLICY_VIOLATION",
        message: issue,
      });
    }

    return {
      safe: issues.length === 0,
      issues,
      diagnostics,
    };
  }

  checkModuleSpecifier(specifier: string): SecurityCheckResult {
    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];

    if (this.hasPathTraversalSequence(specifier)) {
      issues.push(
        `Path traversal is not allowed in module specifier: ${specifier}`,
      );
    }

    if (this.isInternalRuntimeSourceSpecifier(specifier)) {
      return {
        safe: issues.length === 0,
        issues,
        diagnostics,
      };
    }

    const isUrl = this.isUrl(specifier);

    if (isUrl) {
      const parsedUrl = new URL(specifier);
      if (
        !this.policy.allowArbitraryNetwork &&
        !isAllowedNetworkUrl(parsedUrl, this.policy.allowedNetworkHosts)
      ) {
        issues.push(`Network host is not in allowlist: ${parsedUrl.host}`);
      }
    } else {
      const allowed =
        this.policy.allowedModules.length === 0 ||
        this.policy.allowedModules.some((prefix) =>
          specifier.startsWith(prefix),
        );

      if (!allowed) {
        issues.push(`Module specifier is not in allowlist: ${specifier}`);
      }
    }

    for (const issue of issues) {
      diagnostics.push({
        level: "error",
        code: "SECURITY_MODULE_REJECTED",
        message: issue,
      });
    }

    return {
      safe: issues.length === 0,
      issues,
      diagnostics,
    };
  }

  checkCapabilities(
    capabilities: RuntimeCapabilities,
    moduleManifest?: RuntimeModuleManifest,
  ): SecurityCheckResult {
    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];

    const requestedHosts = capabilities.networkHosts ?? [];
    if (!this.policy.allowArbitraryNetwork) {
      for (const host of requestedHosts) {
        if (
          !isAllowedRequestedNetworkHost(host, this.policy.allowedNetworkHosts)
        ) {
          issues.push(`Requested network host is not allowed: ${host}`);
        }
      }
    }

    const requestedModules = capabilities.allowedModules ?? [];
    for (const moduleSpecifier of requestedModules) {
      const effectiveSpecifier = this.resolveManifestSpecifier(
        moduleSpecifier,
        moduleManifest,
      );
      const checkResult = this.checkModuleSpecifier(effectiveSpecifier);
      issues.push(...checkResult.issues);

      if (
        this.policy.requireModuleManifestForBareSpecifiers &&
        this.isBareSpecifier(moduleSpecifier) &&
        !moduleManifest?.[moduleSpecifier]
      ) {
        issues.push(
          `Missing moduleManifest entry for bare specifier: ${moduleSpecifier}`,
        );
      }
    }

    if (
      capabilities.executionProfile !== undefined &&
      !this.policy.allowedExecutionProfiles.includes(
        capabilities.executionProfile,
      )
    ) {
      issues.push(
        `Requested executionProfile ${capabilities.executionProfile} is not allowed`,
      );
    }

    if (
      typeof capabilities.maxImports === "number" &&
      capabilities.maxImports > this.policy.maxAllowedImports
    ) {
      issues.push(
        `Requested maxImports ${capabilities.maxImports} exceeds policy limit ${this.policy.maxAllowedImports}`,
      );
    }

    if (
      typeof capabilities.maxExecutionMs === "number" &&
      capabilities.maxExecutionMs > this.policy.maxAllowedExecutionMs
    ) {
      issues.push(
        `Requested maxExecutionMs ${capabilities.maxExecutionMs} exceeds policy limit ${this.policy.maxAllowedExecutionMs}`,
      );
    }

    if (
      typeof capabilities.maxComponentInvocations === "number" &&
      capabilities.maxComponentInvocations >
        this.policy.maxAllowedComponentInvocations
    ) {
      issues.push(
        `Requested maxComponentInvocations ${capabilities.maxComponentInvocations} exceeds policy limit ${this.policy.maxAllowedComponentInvocations}`,
      );
    }

    for (const issue of issues) {
      diagnostics.push({
        level: "error",
        code: "SECURITY_CAPABILITY_REJECTED",
        message: issue,
      });
    }

    return {
      safe: issues.length === 0,
      issues,
      diagnostics,
    };
  }

  private checkStateModel(state: RuntimeStateModel): string[] {
    const issues: string[] = [];

    const transitions = state.transitions ?? {};
    const transitionEntries = Object.entries(transitions);

    if (transitionEntries.length > this.policy.maxTransitionsPerPlan) {
      issues.push(
        `Transition count ${transitionEntries.length} exceeds maximum ${this.policy.maxTransitionsPerPlan}`,
      );
    }

    for (const [eventType, actions] of transitionEntries) {
      if (actions.length > this.policy.maxActionsPerTransition) {
        issues.push(
          `Transition ${eventType} has ${actions.length} actions which exceeds maximum ${this.policy.maxActionsPerTransition}`,
        );
      }

      for (const action of actions) {
        issues.push(...this.checkAction(eventType, action));
      }
    }

    return issues;
  }

  private async checkRuntimeSource(
    source: RuntimeSourceModule,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): Promise<string[]> {
    const issues: string[] = [];

    if (!this.policy.allowRuntimeSourceModules) {
      issues.push("Runtime source modules are disabled by policy");
      return issues;
    }

    if (source.runtime === "preact" && !this.policy.allowPreactSourceRuntime) {
      issues.push(
        "source.runtime=preact is disabled by policy; use trusted or relaxed profile, or an explicit override",
      );
    }

    const sourceBytes =
      typeof TextEncoder !== "undefined"
        ? new TextEncoder().encode(source.code).length
        : source.code.length;

    if (sourceBytes > this.policy.maxRuntimeSourceBytes) {
      issues.push(
        `Runtime source size ${sourceBytes} exceeds maximum ${this.policy.maxRuntimeSourceBytes} bytes`,
      );
    }

    const sourceImports = await this.parseSourceImports(source.code);
    if (sourceImports.length > this.policy.maxSourceImportSpecifiers) {
      issues.push(
        `Runtime source import count ${sourceImports.length} exceeds maximum ${this.policy.maxSourceImportSpecifiers}`,
      );
    }

    for (const sourceImport of sourceImports) {
      const effectiveSpecifier = this.resolveManifestSpecifier(
        sourceImport,
        moduleManifest,
      );
      const importCheck = this.checkModuleSpecifier(effectiveSpecifier);
      issues.push(...importCheck.issues);

      if (
        this.policy.requireModuleManifestForBareSpecifiers &&
        this.isBareSpecifier(sourceImport) &&
        !moduleManifest?.[sourceImport]
      ) {
        issues.push(
          `Runtime source bare import requires manifest entry: ${sourceImport}`,
        );
      }
    }

    if (
      !this.policy.allowDynamicSourceImports &&
      /\bimport\s*\(/.test(source.code)
    ) {
      issues.push("Runtime source dynamic import() is disabled by policy");
    }

    for (const pattern of this.sourceBannedPatterns) {
      if (pattern.regex.test(source.code)) {
        issues.push(`Runtime source contains blocked pattern: ${pattern.raw}`);
      }
    }

    issues.push(...this.checkRuntimeSourceGlobalAccess(source.code));

    return issues;
  }

  private checkRuntimeSourceGlobalAccess(sourceCode: string): string[] {
    const issues = new Set<string>();

    for (const property of SOURCE_BANNED_GLOBAL_PROPERTIES) {
      if (!this.policyBlocksSourcePattern(property)) {
        continue;
      }

      if (hasIdentifierReference(sourceCode, property)) {
        issues.add(
          `Runtime source contains blocked global access: ${property}`,
        );
      }
    }

    for (const access of collectStaticBracketPropertyAccesses(sourceCode)) {
      const objectName = access.object.toLowerCase();
      const propertyName = access.property.toLowerCase();
      const blockedGlobalProperty = SOURCE_BANNED_GLOBAL_PROPERTIES.find(
        (property) => property.toLowerCase() === propertyName,
      );

      if (
        blockedGlobalProperty &&
        SOURCE_GLOBAL_OBJECTS.some(
          (object) => object.toLowerCase() === objectName,
        ) &&
        this.policyBlocksSourcePattern(blockedGlobalProperty)
      ) {
        issues.add(
          `Runtime source contains blocked global access: ${blockedGlobalProperty}`,
        );
      }

      for (const qualified of SOURCE_BANNED_QUALIFIED_PROPERTIES) {
        if (
          qualified.object.toLowerCase() === objectName &&
          qualified.property.toLowerCase() === propertyName &&
          this.policyBlocksQualifiedSourcePattern(qualified)
        ) {
          issues.add(
            `Runtime source contains blocked global access: ${qualified.object}.${qualified.property}`,
          );
        }
      }
    }

    return [...issues];
  }

  private policyBlocksSourcePattern(needle: string): boolean {
    const normalizedNeedle = needle.toLowerCase();
    return this.policy.sourceBannedPatternStrings.some((pattern) =>
      pattern.toLowerCase().includes(normalizedNeedle),
    );
  }

  private policyBlocksQualifiedSourcePattern(input: {
    object: string;
    property: string;
  }): boolean {
    return (
      this.policyBlocksSourcePattern(input.object) &&
      this.policyBlocksSourcePattern(input.property)
    );
  }

  private checkModuleManifest(moduleManifest: RuntimeModuleManifest): string[] {
    const issues: string[] = [];
    const entryCount = Object.keys(moduleManifest).length;
    if (entryCount > this.policy.maxAllowedImports) {
      issues.push(
        `moduleManifest entry count ${entryCount} exceeds policy limit ${this.policy.maxAllowedImports}`,
      );
    }

    for (const [specifier, descriptor] of Object.entries(moduleManifest)) {
      if (specifier.trim().length === 0) {
        issues.push("moduleManifest contains an empty specifier key");
        continue;
      }

      if (descriptor.resolvedUrl.trim().length === 0) {
        issues.push(`moduleManifest entry has empty resolvedUrl: ${specifier}`);
      }

      if (
        this.policy.requireModuleIntegrity &&
        this.isUrl(descriptor.resolvedUrl)
      ) {
        if (!descriptor.integrity || descriptor.integrity.trim().length === 0) {
          issues.push(
            `moduleManifest entry requires integrity for remote module: ${specifier}`,
          );
        } else if (!this.hasSupportedIntegrity(descriptor.integrity)) {
          issues.push(
            `moduleManifest entry has unsupported integrity format for remote module: ${specifier}`,
          );
        }
      }

      const resolvedCheck = this.checkModuleSpecifier(descriptor.resolvedUrl);
      issues.push(...resolvedCheck.issues);
    }

    return issues;
  }

  private async checkManifestCoverage(
    plan: RuntimePlan,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): Promise<string[]> {
    const issues: string[] = [];
    const requiredSpecifiers = new Set<string>();
    const imports = plan.imports ?? [];

    for (const specifier of imports) {
      requiredSpecifiers.add(specifier);
    }

    for (const specifier of plan.capabilities?.allowedModules ?? []) {
      requiredSpecifiers.add(specifier);
    }

    walkNodes(plan.root, (node) => {
      if (node.type === "component") {
        requiredSpecifiers.add(node.module);
      }
    });

    for (const sourceImport of await this.parseSourceImports(
      plan.source?.code ?? "",
    )) {
      requiredSpecifiers.add(sourceImport);
    }

    for (const specifier of requiredSpecifiers) {
      const descriptor = moduleManifest?.[specifier];
      if (
        this.policy.requireModuleManifestForBareSpecifiers &&
        this.isBareSpecifier(specifier) &&
        !descriptor
      ) {
        issues.push(
          `Missing moduleManifest entry for bare specifier: ${specifier}`,
        );
      }

      if (!this.policy.requireModuleIntegrity) {
        continue;
      }

      if (this.isBareSpecifier(specifier) && !descriptor) {
        if (!this.policy.requireModuleManifestForBareSpecifiers) {
          issues.push(
            `Missing moduleManifest entry required for integrity: ${specifier}`,
          );
        }
        continue;
      }

      if (!this.isUrl(specifier)) {
        continue;
      }

      if (!descriptor) {
        issues.push(
          `Missing moduleManifest entry required for remote module integrity: ${specifier}`,
        );
        continue;
      }

      if (!this.remoteUrlsMatch(specifier, descriptor.resolvedUrl)) {
        issues.push(
          `moduleManifest resolvedUrl does not match direct remote module reference: ${specifier}`,
        );
      }
    }

    return issues;
  }

  private resolveManifestSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): string {
    const descriptor = moduleManifest?.[specifier];
    if (!descriptor || descriptor.resolvedUrl.trim().length === 0) {
      return specifier;
    }

    return descriptor.resolvedUrl;
  }

  private async parseSourceImports(code: string): Promise<string[]> {
    if (code.trim().length === 0) {
      return [];
    }

    return collectRuntimeSourceImports(code);
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private isBareSpecifier(specifier: string): boolean {
    if (this.isInternalRuntimeSourceSpecifier(specifier)) {
      return false;
    }

    return (
      !specifier.startsWith("./") &&
      !specifier.startsWith("../") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("http://") &&
      !specifier.startsWith("https://") &&
      !specifier.startsWith("data:") &&
      !specifier.startsWith("blob:")
    );
  }

  private isInternalRuntimeSourceSpecifier(specifier: string): boolean {
    const normalized = specifier.trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }

    return (
      normalized.startsWith("inline://") ||
      INTERNAL_RUNTIME_SOURCE_MODULE_SPECIFIERS.has(normalized)
    );
  }

  private checkAction(eventType: string, action: RuntimeAction): string[] {
    const issues: string[] = [];

    if (!isSafePath(action.path)) {
      issues.push(`Unsafe action path in ${eventType}: ${action.path}`);
    }

    if (
      action.type === "increment" &&
      typeof action.by === "number" &&
      !Number.isFinite(action.by)
    ) {
      issues.push(`Invalid increment value for ${eventType}: ${action.by}`);
    }

    if (action.type === "set" || action.type === "push") {
      const value = action.value;
      if (isRuntimeValueFromPath(value)) {
        const source = value.$from;
        const allowedPrefix =
          source.startsWith("state.") ||
          source.startsWith("event.") ||
          source.startsWith("context.") ||
          source.startsWith("vars.");

        if (!allowedPrefix) {
          issues.push(`Unsupported value source in ${eventType}: ${source}`);
        }

        if (!isSafePath(source.replace(/^(state|event|context|vars)\./, ""))) {
          issues.push(`Unsafe value source path in ${eventType}: ${source}`);
        }
      }
    }

    return issues;
  }

  private isUrl(specifier: string): boolean {
    try {
      const parsed = new URL(specifier);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private remoteUrlsMatch(reference: string, resolvedUrl: string): boolean {
    try {
      return new URL(reference).href === new URL(resolvedUrl).href;
    } catch {
      return false;
    }
  }

  private hasSupportedIntegrity(integrity: string): boolean {
    return integrity
      .split(/\s+/)
      .map((candidate) => candidate.trim())
      .some((candidate) => {
        if (/^sha256-[A-Za-z0-9+/]{43}=$/.test(candidate)) {
          return true;
        }
        if (/^sha384-[A-Za-z0-9+/]{64}$/.test(candidate)) {
          return true;
        }
        return /^sha512-[A-Za-z0-9+/]{86}==$/.test(candidate);
      });
  }

  private hasPathTraversalSequence(specifier: string): boolean {
    if (specifier.includes("..")) {
      return true;
    }

    for (const decoded of this.decodeSpecifierVariants(specifier)) {
      if (decoded.includes("..")) {
        return true;
      }
    }

    return false;
  }

  private decodeSpecifierVariants(specifier: string): string[] {
    const variants: string[] = [];
    let current = specifier;

    for (let i = 0; i < 2; i += 1) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(current);
      } catch {
        break;
      }

      if (decoded === current) {
        break;
      }

      variants.push(decoded);
      current = decoded;
    }

    return variants;
  }
}

function clonePolicy(policy: RuntimeSecurityPolicy): RuntimeSecurityPolicy {
  return {
    ...policy,
    blockedTags: [...policy.blockedTags],
    allowedModules: [...policy.allowedModules],
    allowedNetworkHosts: [...policy.allowedNetworkHosts],
    allowedExecutionProfiles: [...policy.allowedExecutionProfiles],
    supportedSpecVersions: [...policy.supportedSpecVersions],
    sourceBannedPatternStrings: [...policy.sourceBannedPatternStrings],
  };
}

function splitRuntimeUrlAttributeValue(
  attributeName: string,
  value: string,
): string[] | undefined {
  if (FUNCTIONAL_IRI_RUNTIME_ATTRIBUTE_NAMES.has(attributeName)) {
    return extractFunctionalIriReferences(value);
  }

  if (SOURCE_SET_RUNTIME_URL_ATTRIBUTE_NAMES.has(attributeName)) {
    const candidates = value.split(",");
    const references: string[] = [];
    for (const candidate of candidates) {
      const normalized = candidate.trim();
      if (normalized.length === 0) {
        return undefined;
      }
      const reference = normalized.split(/\s+/, 1)[0];
      if (!reference) {
        return undefined;
      }
      references.push(reference);
    }
    return references;
  }

  if (LIST_RUNTIME_URL_ATTRIBUTE_NAMES.has(attributeName)) {
    const references = value.trim().split(/\s+/).filter(Boolean);
    return references.length > 0 ? references : undefined;
  }

  if (SINGLE_RUNTIME_URL_ATTRIBUTE_NAMES.has(attributeName)) {
    return [value];
  }

  return undefined;
}

function extractFunctionalIriReferences(value: string): string[] | undefined {
  const normalized = normalizeCssForUrlSecurityInspection(value);
  if (
    normalized.length === 0 ||
    CSS_IMAGE_SET_FUNCTION_PATTERN.test(normalized)
  ) {
    return undefined;
  }

  const references: string[] = [];
  const unmatched = normalized.replace(
    /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()]*))\s*\)/gi,
    (_match, doubleQuoted: string, singleQuoted: string, unquoted: string) => {
      references.push(doubleQuoted ?? singleQuoted ?? unquoted ?? "");
      return "";
    },
  );

  if (/url\s*\(/i.test(unmatched)) {
    return undefined;
  }

  return references;
}

function inspectRuntimeUrlReference(
  reference: string,
  allowSafeNonNetworkProtocol: boolean,
): {
  safe: boolean;
  remoteUrl?: URL;
  relativeUrl?: string;
  nonNetworkProtocolUrl?: string;
} {
  const normalized = normalizeUrlForSecurityInspection(reference);
  if (normalized.length === 0 || normalized.includes("\\")) {
    return { safe: false };
  }

  if (normalized.startsWith("//")) {
    try {
      return {
        safe: true,
        remoteUrl: new URL(`https:${normalized}`),
      };
    } catch {
      return { safe: false };
    }
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1];
  if (!scheme) {
    return { safe: true, relativeUrl: normalized };
  }

  const protocol = `${scheme.toLowerCase()}:`;
  if (protocol === "http:" || protocol === "https:") {
    try {
      return {
        safe: true,
        remoteUrl: new URL(normalized),
      };
    } catch {
      return { safe: false };
    }
  }

  const safe =
    allowSafeNonNetworkProtocol && SAFE_NON_NETWORK_URL_PROTOCOLS.has(protocol);
  return {
    safe,
    ...(safe ? { nonNetworkProtocolUrl: normalized } : {}),
  };
}

function normalizeCssForUrlSecurityInspection(value: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  return decodeCssEscapesForUrlInspection(withoutComments).replaceAll(
    String.fromCodePoint(0),
    "",
  );
}

function decodeCssEscapesForUrlInspection(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|(.))/g,
    (
      _match,
      hexCodePoint: string | undefined,
      lineContinuation: string | undefined,
      escapedCharacter: string | undefined,
    ) => {
      if (lineContinuation) {
        return "";
      }
      if (!hexCodePoint) {
        return escapedCharacter ?? "";
      }

      const codePoint = Number.parseInt(hexCodePoint, 16);
      if (
        !Number.isFinite(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff
      ) {
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function normalizeUrlForSecurityInspection(value: string): string {
  return Array.from(value.trim())
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");
}

function compileSourceBannedPatterns(patterns: string[]): Array<{
  raw: string;
  regex: RegExp;
}> {
  const compiled: Array<{
    raw: string;
    regex: RegExp;
  }> = [];

  for (const patternText of patterns) {
    try {
      compiled.push({
        raw: patternText,
        regex: new RegExp(patternText, "i"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid source banned pattern ${JSON.stringify(patternText)}: ${message}`,
      );
    }
  }

  return compiled;
}

function hasIdentifierReference(
  sourceCode: string,
  identifier: string,
): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "i").test(sourceCode);
}

function collectStaticBracketPropertyAccesses(
  sourceCode: string,
): Array<{ object: string; property: string }> {
  const accesses: Array<{ object: string; property: string }> = [];
  const pattern =
    /\b(globalThis|self|window|document|navigator|process)\s*\[\s*((?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*(?:\+\s*)?)+)\]/gi;

  for (const match of sourceCode.matchAll(pattern)) {
    const object = match[1];
    const expression = match[2];
    if (!object || !expression) {
      continue;
    }

    const property = evaluateStaticStringExpression(expression);
    if (property === undefined) {
      continue;
    }

    accesses.push({ object, property });
  }

  return accesses;
}

function evaluateStaticStringExpression(
  expression: string,
): string | undefined {
  let remainder = expression.trim();
  let value = "";

  while (remainder.length > 0) {
    const literalMatch =
      /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/s.exec(
        remainder,
      );
    if (!literalMatch?.[0]) {
      return undefined;
    }

    const decoded = decodeStaticStringLiteral(literalMatch[0]);
    if (decoded === undefined) {
      return undefined;
    }
    value += decoded;
    remainder = remainder.slice(literalMatch[0].length).trim();
    if (remainder.length === 0) {
      return value;
    }
    if (!remainder.startsWith("+")) {
      return undefined;
    }
    remainder = remainder.slice(1).trim();
  }

  return value;
}

function decodeStaticStringLiteral(literal: string): string | undefined {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === "`" && body.includes("${")) {
    return undefined;
  }

  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
    (_match, escaped: string) => decodeEscapeSequence(escaped),
  );
}

function decodeEscapeSequence(escaped: string): string {
  if (escaped.startsWith("u{")) {
    const codePoint = Number.parseInt(escaped.slice(2, -1), 16);
    return codePointToString(codePoint);
  }

  if (escaped.startsWith("u") || escaped.startsWith("x")) {
    const codePoint = Number.parseInt(escaped.slice(1), 16);
    return codePointToString(codePoint);
  }

  const escapes: Record<string, string> = {
    "0": "\0",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };

  return escapes[escaped] ?? escaped;
}

function codePointToString(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }

  return String.fromCodePoint(codePoint);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walkNodes(
  node: RuntimeNode,
  visitor: (node: RuntimeNode) => void,
): void {
  visitor(node);
  if (node.type === "text") {
    return;
  }

  for (const child of node.children ?? []) {
    walkNodes(child, visitor);
  }
}

function normalizeInitializationInput(
  input: SecurityInitializationInput,
): SecurityInitializationOptions {
  if (!input) {
    return {};
  }

  if (isSecurityInitializationOptions(input)) {
    return input;
  }

  return {
    overrides: input,
  };
}

function isSecurityInitializationOptions(
  value: SecurityInitializationInput,
): value is SecurityInitializationOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return "profile" in value || "overrides" in value;
}
