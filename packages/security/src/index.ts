import {
  isRuntimeValueFromPath,
  isSafePath,
  type RuntimeAction,
  type RuntimeCapabilities,
  type RuntimeDiagnostic,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimeSourceModule,
  type RuntimeStateModel,
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
  allowedExecutionProfiles: Array<"standard" | "isolated-vm">;
  maxTransitionsPerPlan: number;
  maxActionsPerTransition: number;
  maxAllowedImports: number;
  maxAllowedExecutionMs: number;
  maxAllowedComponentInvocations: number;
  allowRuntimeSourceModules: boolean;
  maxRuntimeSourceBytes: number;
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
  checkPlan(plan: RuntimePlan): SecurityCheckResult;
  checkModuleSpecifier(specifier: string): SecurityCheckResult;
  checkCapabilities(capabilities: RuntimeCapabilities): SecurityCheckResult;
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
    allowedExecutionProfiles: ["standard", "isolated-vm"],
    maxTransitionsPerPlan: 40,
    maxActionsPerTransition: 20,
    maxAllowedImports: 80,
    maxAllowedExecutionMs: 5000,
    maxAllowedComponentInvocations: 120,
    allowRuntimeSourceModules: true,
    maxRuntimeSourceBytes: 20000,
  },
  balanced: {
    blockedTags: ["script", "iframe", "object", "embed", "link", "meta"],
    maxTreeDepth: 12,
    maxNodeCount: 500,
    allowInlineEventHandlers: false,
    allowedModules: ["/", "npm:"],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
    allowArbitraryNetwork: false,
    allowedExecutionProfiles: ["standard", "isolated-vm"],
    maxTransitionsPerPlan: 100,
    maxActionsPerTransition: 50,
    maxAllowedImports: 200,
    maxAllowedExecutionMs: 15000,
    maxAllowedComponentInvocations: 500,
    allowRuntimeSourceModules: true,
    maxRuntimeSourceBytes: 80000,
  },
  relaxed: {
    blockedTags: ["script", "iframe", "object", "embed"],
    maxTreeDepth: 24,
    maxNodeCount: 2000,
    allowInlineEventHandlers: true,
    allowedModules: ["/", "npm:", "https://ga.jspm.io/", "https://cdn.jspm.io/"],
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io", "esm.sh", "unpkg.com"],
    allowArbitraryNetwork: true,
    allowedExecutionProfiles: ["standard", "isolated-vm"],
    maxTransitionsPerPlan: 400,
    maxActionsPerTransition: 150,
    maxAllowedImports: 1000,
    maxAllowedExecutionMs: 60000,
    maxAllowedComponentInvocations: 4000,
    allowRuntimeSourceModules: true,
    maxRuntimeSourceBytes: 200000,
  },
};

const DEFAULT_SECURITY_PROFILE: RuntimeSecurityProfile = "balanced";

export function listSecurityProfiles(): RuntimeSecurityProfile[] {
  return Object.keys(SECURITY_PROFILE_POLICIES) as RuntimeSecurityProfile[];
}

export function getSecurityProfilePolicy(
  profile: RuntimeSecurityProfile
): RuntimeSecurityPolicy {
  return clonePolicy(SECURITY_PROFILE_POLICIES[profile]);
}

export class DefaultSecurityChecker implements SecurityChecker {
  private policy: RuntimeSecurityPolicy = getSecurityProfilePolicy(
    DEFAULT_SECURITY_PROFILE
  );
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
    };
    this.profile = profile;
  }

  getPolicy(): RuntimeSecurityPolicy {
    return { ...this.policy };
  }

  getProfile(): RuntimeSecurityProfile {
    return this.profile;
  }

  checkPlan(plan: RuntimePlan): SecurityCheckResult {
    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];

    const capabilityResult = this.checkCapabilities(plan.capabilities);
    issues.push(...capabilityResult.issues);
    diagnostics.push(...capabilityResult.diagnostics);

    let nodeCount = 0;

    const walk = (node: RuntimeNode, depth: number) => {
      nodeCount += 1;

      if (depth > this.policy.maxTreeDepth) {
        issues.push(
          `Node depth ${depth} exceeds maximum ${this.policy.maxTreeDepth}`
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
        const componentResult = this.checkModuleSpecifier(node.module);
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
        `Node count ${nodeCount} exceeds maximum ${this.policy.maxNodeCount}`
      );
    }

    const importSpecifiers = plan.imports ?? [];
    for (const specifier of importSpecifiers) {
      const importCheck = this.checkModuleSpecifier(specifier);
      issues.push(...importCheck.issues);
    }

    if (plan.state) {
      issues.push(...this.checkStateModel(plan.state));
    }

    if (plan.source) {
      issues.push(...this.checkRuntimeSource(plan.source));
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

    if (specifier.includes("..")) {
      issues.push(`Path traversal is not allowed in module specifier: ${specifier}`);
    }

    const isUrl = this.isUrl(specifier);

    if (isUrl) {
      const parsedUrl = new URL(specifier);
      if (
        !this.policy.allowArbitraryNetwork &&
        !this.policy.allowedNetworkHosts.includes(parsedUrl.host)
      ) {
        issues.push(`Network host is not in allowlist: ${parsedUrl.host}`);
      }
    } else {
      const allowed =
        this.policy.allowedModules.length === 0 ||
        this.policy.allowedModules.some((prefix) => specifier.startsWith(prefix));

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

  checkCapabilities(capabilities: RuntimeCapabilities): SecurityCheckResult {
    const issues: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [];

    const requestedHosts = capabilities.networkHosts ?? [];
    if (!this.policy.allowArbitraryNetwork) {
      for (const host of requestedHosts) {
        if (!this.policy.allowedNetworkHosts.includes(host)) {
          issues.push(`Requested network host is not allowed: ${host}`);
        }
      }
    }

    const requestedModules = capabilities.allowedModules ?? [];
    for (const moduleSpecifier of requestedModules) {
      const checkResult = this.checkModuleSpecifier(moduleSpecifier);
      issues.push(...checkResult.issues);
    }

    if (
      capabilities.executionProfile !== undefined &&
      !this.policy.allowedExecutionProfiles.includes(
        capabilities.executionProfile
      )
    ) {
      issues.push(
        `Requested executionProfile ${capabilities.executionProfile} is not allowed`
      );
    }

    if (
      typeof capabilities.maxImports === "number" &&
      capabilities.maxImports > this.policy.maxAllowedImports
    ) {
      issues.push(
        `Requested maxImports ${capabilities.maxImports} exceeds policy limit ${this.policy.maxAllowedImports}`
      );
    }

    if (
      typeof capabilities.maxExecutionMs === "number" &&
      capabilities.maxExecutionMs > this.policy.maxAllowedExecutionMs
    ) {
      issues.push(
        `Requested maxExecutionMs ${capabilities.maxExecutionMs} exceeds policy limit ${this.policy.maxAllowedExecutionMs}`
      );
    }

    if (
      typeof capabilities.maxComponentInvocations === "number" &&
      capabilities.maxComponentInvocations >
        this.policy.maxAllowedComponentInvocations
    ) {
      issues.push(
        `Requested maxComponentInvocations ${capabilities.maxComponentInvocations} exceeds policy limit ${this.policy.maxAllowedComponentInvocations}`
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
        `Transition count ${transitionEntries.length} exceeds maximum ${this.policy.maxTransitionsPerPlan}`
      );
    }

    for (const [eventType, actions] of transitionEntries) {
      if (actions.length > this.policy.maxActionsPerTransition) {
        issues.push(
          `Transition ${eventType} has ${actions.length} actions which exceeds maximum ${this.policy.maxActionsPerTransition}`
        );
      }

      for (const action of actions) {
        issues.push(...this.checkAction(eventType, action));
      }
    }

    return issues;
  }

  private checkRuntimeSource(source: RuntimeSourceModule): string[] {
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
        `Runtime source size ${sourceBytes} exceeds maximum ${this.policy.maxRuntimeSourceBytes} bytes`
      );
    }

    return issues;
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
}

function clonePolicy(policy: RuntimeSecurityPolicy): RuntimeSecurityPolicy {
  return {
    ...policy,
    blockedTags: [...policy.blockedTags],
    allowedModules: [...policy.allowedModules],
    allowedNetworkHosts: [...policy.allowedNetworkHosts],
    allowedExecutionProfiles: [...policy.allowedExecutionProfiles],
  };
}

function normalizeInitializationInput(
  input: SecurityInitializationInput
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
  value: SecurityInitializationInput
): value is SecurityInitializationOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return "profile" in value || "overrides" in value;
}
