import {
  collectRuntimeSourceImports,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  isRuntimeValueFromPath,
  isSafePath,
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
  maxRuntimeSourceBytes: number;
  supportedSpecVersions: string[];
  requireSpecVersion: boolean;
  requireModuleManifestForBareSpecifiers: boolean;
  requireModuleIntegrity: boolean;
  allowDynamicSourceImports: boolean;
  sourceBannedPatternStrings: string[];
  maxSourceImportSpecifiers: number;
}

export type RuntimeSecurityProfile = "strict" | "balanced" | "relaxed";

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
    allowRuntimeSourceModules: true,
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
    allowRuntimeSourceModules: true,
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

export function listSecurityProfiles(): RuntimeSecurityProfile[] {
  return Object.keys(SECURITY_PROFILE_POLICIES) as RuntimeSecurityProfile[];
}

export function getSecurityProfilePolicy(
  profile: RuntimeSecurityProfile,
): RuntimeSecurityPolicy {
  return clonePolicy(SECURITY_PROFILE_POLICIES[profile]);
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

    this.policy = {
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
    };
    this.sourceBannedPatterns = compileSourceBannedPatterns(
      this.policy.sourceBannedPatternStrings,
    );
    this.profile = profile;
  }

  getPolicy(): RuntimeSecurityPolicy {
    return { ...this.policy };
  }

  getProfile(): RuntimeSecurityProfile {
    return this.profile;
  }

  async checkPlan(plan: RuntimePlan): Promise<SecurityCheckResult> {
    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];
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

    if (this.policy.requireModuleManifestForBareSpecifiers) {
      issues.push(...(await this.checkManifestCoverage(plan, moduleManifest)));
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
          for (const key of Object.keys(node.props)) {
            if (
              !this.policy.allowInlineEventHandlers &&
              /^on[A-Z]|^on[a-z]/.test(key)
            ) {
              issues.push(`Inline event handler is not allowed: ${key}`);
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

    return issues;
  }

  private checkModuleManifest(moduleManifest: RuntimeModuleManifest): string[] {
    const issues: string[] = [];

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
        this.isUrl(descriptor.resolvedUrl) &&
        (!descriptor.integrity || descriptor.integrity.trim().length === 0)
      ) {
        issues.push(
          `moduleManifest entry requires integrity for remote module: ${specifier}`,
        );
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
      if (this.isBareSpecifier(specifier)) {
        requiredSpecifiers.add(specifier);
      }
    }

    for (const specifier of plan.capabilities?.allowedModules ?? []) {
      if (this.isBareSpecifier(specifier)) {
        requiredSpecifiers.add(specifier);
      }
    }

    walkNodes(plan.root, (node) => {
      if (node.type === "component" && this.isBareSpecifier(node.module)) {
        requiredSpecifiers.add(node.module);
      }
    });

    for (const sourceImport of await this.parseSourceImports(
      plan.source?.code ?? "",
    )) {
      if (this.isBareSpecifier(sourceImport)) {
        requiredSpecifiers.add(sourceImport);
      }
    }

    for (const specifier of requiredSpecifiers) {
      if (!moduleManifest?.[specifier]) {
        issues.push(
          `Missing moduleManifest entry for bare specifier: ${specifier}`,
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
    } catch {}
  }

  return compiled;
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

interface ParsedNetworkHostPattern {
  hostname: string;
  wildcard: boolean;
  port?: number;
}

function isAllowedNetworkUrl(url: URL, allowedHosts: string[]): boolean {
  const urlHostname = url.hostname.toLowerCase();
  const effectivePort = toEffectivePort(url);

  if (!effectivePort) {
    return false;
  }

  for (const allowed of allowedHosts) {
    const pattern = parseNetworkHostPattern(allowed);
    if (!pattern) {
      continue;
    }

    if (!matchesPatternHostname(urlHostname, pattern)) {
      continue;
    }

    if (pattern.port !== undefined) {
      if (pattern.port === effectivePort) {
        return true;
      }
      continue;
    }

    if (matchesImplicitDefaultPort(url.protocol, effectivePort)) {
      return true;
    }
  }

  return false;
}

function isAllowedRequestedNetworkHost(
  requestedHost: string,
  allowedHosts: string[],
): boolean {
  const requested = parseNetworkHostPattern(requestedHost);
  if (!requested) {
    return false;
  }

  for (const allowed of allowedHosts) {
    const pattern = parseNetworkHostPattern(allowed);
    if (!pattern) {
      continue;
    }

    if (!matchesPatternHostname(requested.hostname, pattern)) {
      continue;
    }

    if (pattern.port !== undefined) {
      if (requested.port === pattern.port) {
        return true;
      }
      continue;
    }

    if (
      requested.port === undefined ||
      requested.port === 80 ||
      requested.port === 443
    ) {
      return true;
    }
  }

  return false;
}

function parseNetworkHostPattern(
  value: string,
): ParsedNetworkHostPattern | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  const wildcard = normalized.startsWith("*.");
  const hostPort = wildcard ? normalized.slice(2) : normalized;
  if (hostPort.length === 0) {
    return undefined;
  }

  const parsed = parseHostnameAndPort(hostPort);
  if (!parsed) {
    return undefined;
  }

  return {
    hostname: parsed.hostname,
    wildcard,
    port: parsed.port,
  };
}

function parseHostnameAndPort(
  hostPort: string,
): { hostname: string; port?: number } | undefined {
  const bracketMatch = hostPort.match(/^\[(.+)\](?::(\d+))?$/);
  if (bracketMatch) {
    const hostname = bracketMatch[1]?.trim();
    if (!hostname) {
      return undefined;
    }
    const port = parsePortNumber(bracketMatch[2]);
    return port === undefined && bracketMatch[2]
      ? undefined
      : { hostname, port };
  }

  const segments = hostPort.split(":");
  if (segments.length === 1) {
    return {
      hostname: hostPort,
    };
  }

  if (segments.length === 2) {
    const hostname = segments[0]?.trim();
    const port = parsePortNumber(segments[1]);
    if (!hostname || port === undefined) {
      return undefined;
    }
    return {
      hostname,
      port,
    };
  }

  return undefined;
}

function parsePortNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function matchesPatternHostname(
  hostname: string,
  pattern: ParsedNetworkHostPattern,
): boolean {
  if (!pattern.wildcard) {
    return hostname === pattern.hostname;
  }

  return (
    hostname.length > pattern.hostname.length &&
    hostname.endsWith(`.${pattern.hostname}`)
  );
}

function toEffectivePort(url: URL): number | undefined {
  if (url.port.length > 0) {
    const parsedPort = Number(url.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return undefined;
    }
    return parsedPort;
  }

  if (url.protocol === "https:") {
    return 443;
  }
  if (url.protocol === "http:") {
    return 80;
  }

  return undefined;
}

function matchesImplicitDefaultPort(protocol: string, port: number): boolean {
  if (protocol === "https:") {
    return port === 443;
  }

  if (protocol === "http:") {
    return port === 80;
  }

  return false;
}
