import {
  isRuntimePlan,
  RUNTIME_PLAN_SPEC_VERSION_V1,
  type RuntimePlan,
  walkRuntimeNode,
} from "@renderify/ir";
import {
  inspectRuntimeUrlAttribute,
  isRuntimeUrlAttribute,
} from "@renderify/security";

export const DEFAULT_MCP_PLAN_MAX_BYTES = 512 * 1024;
export const MAX_MCP_PLAN_MAX_BYTES = 5 * 1024 * 1024;

const MCP_LOCAL_FRAGMENT_ATTRIBUTE_NAMES = new Set([
  "href",
  "usemap",
  "xlink:href",
  "xlinkhref",
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

export type DeclarativeMcpPlanErrorCode =
  | "INVALID_LIMIT"
  | "INVALID_PLAN"
  | "PLAN_TOO_LARGE"
  | "UNSUPPORTED_SPEC_VERSION"
  | "RUNTIME_SOURCE_DISABLED"
  | "REMOTE_MODULES_DISABLED"
  | "COMPONENT_NODES_DISABLED"
  | "NETWORK_DISABLED"
  | "PERSISTENT_STORAGE_DISABLED"
  | "TIMERS_DISABLED"
  | "EXECUTION_PROFILE_DISABLED";

export class DeclarativeMcpPlanError extends Error {
  readonly code: DeclarativeMcpPlanErrorCode;

  constructor(code: DeclarativeMcpPlanErrorCode, message: string) {
    super(message);
    this.name = "DeclarativeMcpPlanError";
    this.code = code;
  }
}

export interface ParseDeclarativeMcpPlanOptions {
  maxBytes?: number;
}

export function parseDeclarativeMcpPlan(
  value: unknown,
  options: ParseDeclarativeMcpPlanOptions = {},
): RuntimePlan {
  const maxBytes = resolveMaxPlanBytes(options.maxBytes);
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DeclarativeMcpPlanError(
      "INVALID_PLAN",
      "RuntimePlan must be serializable JSON",
    );
  }

  if (serialized === undefined) {
    throw new DeclarativeMcpPlanError(
      "INVALID_PLAN",
      "RuntimePlan must be a JSON object",
    );
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maxBytes) {
    throw new DeclarativeMcpPlanError(
      "PLAN_TOO_LARGE",
      `RuntimePlan is ${bytes} bytes; the limit is ${maxBytes} bytes`,
    );
  }

  const plan = JSON.parse(serialized) as unknown;
  if (!isRuntimePlan(plan)) {
    throw new DeclarativeMcpPlanError(
      "INVALID_PLAN",
      "Value is not a valid RuntimePlan",
    );
  }

  assertOfflineDeclarativePlan(plan);
  return plan;
}

export function isOfflineDeclarativePlan(
  value: unknown,
  options: ParseDeclarativeMcpPlanOptions = {},
): value is RuntimePlan {
  try {
    parseDeclarativeMcpPlan(value, options);
    return true;
  } catch {
    return false;
  }
}

export function readDeclarativePlanFromToolResult(
  result: unknown,
  options: ParseDeclarativeMcpPlanOptions = {},
): RuntimePlan | undefined {
  if (!isRecord(result) || !isRecord(result.structuredContent)) {
    return undefined;
  }
  const payload = result.structuredContent.renderify;
  if (payload === undefined) {
    return undefined;
  }
  if (!isRecord(payload) || !("plan" in payload)) {
    throw new DeclarativeMcpPlanError(
      "INVALID_PLAN",
      "structuredContent.renderify must contain a declarative RuntimePlan",
    );
  }
  return parseDeclarativeMcpPlan(payload.plan, options);
}

function resolveMaxPlanBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MCP_PLAN_MAX_BYTES;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_MCP_PLAN_MAX_BYTES
  ) {
    throw new DeclarativeMcpPlanError(
      "INVALID_LIMIT",
      `maxBytes must be an integer between 1 and ${MAX_MCP_PLAN_MAX_BYTES}`,
    );
  }
  return resolved;
}

function assertOfflineDeclarativePlan(plan: RuntimePlan): void {
  if (plan.specVersion !== RUNTIME_PLAN_SPEC_VERSION_V1) {
    throw new DeclarativeMcpPlanError(
      "UNSUPPORTED_SPEC_VERSION",
      `MCP Apps require specVersion ${RUNTIME_PLAN_SPEC_VERSION_V1}`,
    );
  }

  if (plan.source !== undefined) {
    throw new DeclarativeMcpPlanError(
      "RUNTIME_SOURCE_DISABLED",
      "Runtime source modules are disabled in MCP Apps",
    );
  }

  if (
    (plan.imports?.length ?? 0) > 0 ||
    Object.keys(plan.moduleManifest ?? {}).length > 0 ||
    (plan.capabilities?.allowedModules?.length ?? 0) > 0
  ) {
    throw new DeclarativeMcpPlanError(
      "REMOTE_MODULES_DISABLED",
      "Imports, module manifests, and external modules are disabled in MCP Apps",
    );
  }

  let hasComponentNode = false;
  walkRuntimeNode(plan.root, (node) => {
    if (node.type === "component") {
      hasComponentNode = true;
    }
  });
  if (hasComponentNode) {
    throw new DeclarativeMcpPlanError(
      "COMPONENT_NODES_DISABLED",
      "Component nodes are disabled in offline MCP Apps",
    );
  }

  let hasExternalOrUnsafeUrl = false;
  walkRuntimeNode(plan.root, (node) => {
    if (node.type !== "element") {
      return;
    }
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (!isRuntimeUrlAttribute(name) || typeof value !== "string") {
        continue;
      }
      const inspection = inspectRuntimeUrlAttribute(name, value);
      if (
        !inspection.safe ||
        inspection.remoteUrls.length > 0 ||
        inspection.relativeUrls === undefined ||
        inspection.nonNetworkProtocolUrls === undefined ||
        inspection.nonNetworkProtocolUrls.length > 0 ||
        inspection.relativeUrls.some(
          (reference) => !isAllowedLocalFragmentReference(name, reference),
        )
      ) {
        hasExternalOrUnsafeUrl = true;
      }
    }
  });
  if (hasExternalOrUnsafeUrl) {
    throw new DeclarativeMcpPlanError(
      "NETWORK_DISABLED",
      "External and unsafe URL attributes are disabled in MCP Apps",
    );
  }

  if ((plan.capabilities?.networkHosts?.length ?? 0) > 0) {
    throw new DeclarativeMcpPlanError(
      "NETWORK_DISABLED",
      "Network capabilities are disabled in MCP Apps",
    );
  }

  if ((plan.capabilities?.storage?.length ?? 0) > 0) {
    throw new DeclarativeMcpPlanError(
      "PERSISTENT_STORAGE_DISABLED",
      "Persistent browser storage is disabled in MCP Apps",
    );
  }

  if (plan.capabilities?.timers === true) {
    throw new DeclarativeMcpPlanError(
      "TIMERS_DISABLED",
      "Timer capabilities are disabled in MCP Apps",
    );
  }

  const executionProfile = plan.capabilities?.executionProfile;
  if (executionProfile !== undefined && executionProfile !== "standard") {
    throw new DeclarativeMcpPlanError(
      "EXECUTION_PROFILE_DISABLED",
      "Only the standard declarative execution profile is available in MCP Apps",
    );
  }
}

function isAllowedLocalFragmentReference(
  attributeName: string,
  reference: string,
): boolean {
  return (
    MCP_LOCAL_FRAGMENT_ATTRIBUTE_NAMES.has(attributeName.toLowerCase()) &&
    reference.startsWith("#")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
