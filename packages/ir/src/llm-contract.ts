/**
 * The single LLM-facing contract for RuntimePlans: a JSON Schema that every
 * provider sends as structured-output guidance, and diagnostics that every
 * provider returns when a model's payload does not validate. Keeping both here
 * means OpenAI, Anthropic, Google, Ollama, LM Studio, and Codex models are held
 * to the same shape and receive the same repair feedback.
 */
import { hashStringFNV1a64Hex } from "./hash";
import {
  collectRuntimePlanTemplateDiagnostics,
  isJsonValue,
  isRuntimeCapabilities,
  isRuntimeModuleManifest,
  isRuntimePlan,
  isRuntimePlanMetadata,
  isRuntimeSourceLanguage,
  isRuntimeSourceRuntime,
  isRuntimeStateModel,
  normalizeRuntimeNodeCandidate,
  normalizeRuntimePlanCandidate,
  type RuntimePlan,
} from "./index";

export type RuntimePlanJsonSchema = Record<string, unknown>;

export interface RuntimePlanJsonSchemaOptions {
  /**
   * How many levels of nested `children` are described before the schema
   * falls back to an open object. Providers reject unbounded recursion, so the
   * depth is finite; local validation still checks the full tree.
   * @defaultValue 6
   */
  nodeDepth?: number;
  /**
   * Whether to describe the top-level `source` module. Pass `false` for
   * declarative-only policies so models are not invited to emit code.
   * @defaultValue true
   */
  includeSource?: boolean;
}

export const RUNTIME_PLAN_INVALID_PAYLOAD_MESSAGE =
  "Structured payload is not a valid RuntimePlan";

const DEFAULT_NODE_DEPTH = 6;
const DEFAULT_MAX_DIAGNOSTICS = 8;

const TEMPLATE_GUIDANCE = `Runtime templates use {{state.path}} path lookups only; never use \${...} or JavaScript expressions.`;

function createRuntimeNodeJsonSchema(
  remainingDepth: number,
): RuntimePlanJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: {
        type: "string",
        enum: ["text", "element", "component"],
      },
      value: {
        type: "string",
        description: `Text content. ${TEMPLATE_GUIDANCE}`,
      },
      tag: { type: "string", minLength: 1 },
      module: { type: "string", minLength: 1 },
      exportName: { type: "string", minLength: 1 },
      props: {
        type: "object",
        additionalProperties: true,
        description:
          "HTML props and styles. Dynamic values use {{state.path}} path lookups only. Event props contain static transition names.",
      },
      children: {
        type: "array",
        items:
          remainingDepth > 0
            ? createRuntimeNodeJsonSchema(remainingDepth - 1)
            : { type: "object", additionalProperties: true },
      },
    },
  };
}

function createRuntimeActionJsonSchema(): RuntimePlanJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "path"],
    properties: {
      type: {
        type: "string",
        enum: ["set", "increment", "toggle", "push"],
      },
      path: { type: "string", minLength: 1 },
      value: {
        description:
          'Required for set/push. Use literal JSON or {"$from":"event.payload.value"}; never use template or JavaScript expressions.',
      },
      by: {
        type: "number",
        description: "Optional numeric delta for increment actions only.",
      },
    },
  };
}

/**
 * Builds the canonical RuntimePlan JSON Schema used for structured output.
 * The schema is non-strict guidance: RuntimePlans contain open JSON objects
 * (props, metadata, state), so callers must still validate locally with
 * {@link diagnoseRuntimePlanCandidate}.
 */
export function createRuntimePlanJsonSchema(
  options: RuntimePlanJsonSchemaOptions = {},
): RuntimePlanJsonSchema {
  const nodeDepth = Math.max(
    0,
    Math.floor(options.nodeDepth ?? DEFAULT_NODE_DEPTH),
  );
  const properties: Record<string, unknown> = {
    specVersion: {
      type: "string",
      enum: ["runtime-plan/v1"],
    },
    id: {
      type: "string",
      minLength: 1,
    },
    version: {
      type: "integer",
      minimum: 1,
    },
    root: createRuntimeNodeJsonSchema(nodeDepth),
    // Budgets and permissions (allowedModules, maxExecutionMs, ...) are
    // host-controlled policy, so models may only declare domWrite.
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        domWrite: { type: "boolean" },
      },
    },
    imports: {
      type: "array",
      items: {
        type: "string",
      },
    },
    moduleManifest: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["resolvedUrl"],
        properties: {
          resolvedUrl: { type: "string", minLength: 1 },
          integrity: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          signer: { type: "string", minLength: 1 },
        },
      },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
    state: {
      type: "object",
      additionalProperties: false,
      required: ["initial"],
      properties: {
        initial: {
          type: "object",
          additionalProperties: true,
          description:
            "Literal initial JSON values only. Do not place templates, derived values, or JavaScript expressions here.",
        },
        transitions: {
          type: "object",
          description:
            "Maps each static runtime event name to an array of RuntimeAction objects; never use an object patch map.",
          additionalProperties: {
            type: "array",
            items: createRuntimeActionJsonSchema(),
          },
        },
      },
    },
  };

  if (options.includeSource !== false) {
    properties.source = {
      type: "object",
      additionalProperties: false,
      required: ["language", "code"],
      properties: {
        language: {
          type: "string",
          enum: ["js", "jsx", "ts", "tsx"],
        },
        code: {
          type: "string",
          minLength: 1,
        },
        exportName: {
          type: "string",
          minLength: 1,
        },
        runtime: {
          type: "string",
          enum: ["renderify", "preact"],
        },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["specVersion", "id", "version", "root", "capabilities"],
    properties,
  };
}

/** The canonical schema with default options. Treat it as read-only. */
export const RUNTIME_PLAN_JSON_SCHEMA: RuntimePlanJsonSchema =
  createRuntimePlanJsonSchema();

export interface AcceptRuntimePlanCandidateOptions
  extends DiagnoseRuntimePlanOptions {
  /**
   * Seed for the deterministic-looking fallback plan id that is assigned when
   * a model omits `id`, such as the provider response id plus the prompt.
   */
  fallbackIdSeed?: string;
}

export type RuntimePlanCandidateResult =
  | { valid: true; plan: RuntimePlan; normalized: boolean }
  | { valid: false; errors: string[] };

let fallbackPlanIdSequence = 0;

/**
 * Accepts a model payload with the same rules for every provider: canonical
 * RuntimePlans pass unchanged, recoverable variants (for example a missing
 * `id` or a legacy `nodes` envelope) are normalized, and anything else is
 * rejected with {@link RUNTIME_PLAN_INVALID_PAYLOAD_MESSAGE} followed by
 * repair diagnostics.
 */
export function acceptRuntimePlanCandidate(
  value: unknown,
  options: AcceptRuntimePlanCandidateOptions = {},
): RuntimePlanCandidateResult {
  fallbackPlanIdSequence += 1;
  // The hex digest drops leading zeros; pad so ids always have 16 hex digits.
  const fallbackId = `renderify_${hashStringFNV1a64Hex(
    [
      options.fallbackIdSeed ?? "plan",
      Date.now().toString(36),
      fallbackPlanIdSequence.toString(36),
    ].join("\0"),
  ).padStart(16, "0")}`;
  const plan = normalizeRuntimePlanCandidate(value, { fallbackId });
  if (plan) {
    return { valid: true, plan, normalized: plan !== value };
  }
  return {
    valid: false,
    errors: [
      RUNTIME_PLAN_INVALID_PAYLOAD_MESSAGE,
      ...diagnoseRuntimePlanCandidate(value, options),
    ],
  };
}

export interface DiagnoseRuntimePlanOptions {
  /** Maximum number of diagnostics to collect. @defaultValue 8 */
  maxDiagnostics?: number;
}

/**
 * Explains why a model payload is not a renderable RuntimePlan, in terms a
 * model can act on in a repair prompt. Returns an empty array when the payload
 * is a valid plan with well-formed templates.
 */
export function diagnoseRuntimePlanCandidate(
  value: unknown,
  options: DiagnoseRuntimePlanOptions = {},
): string[] {
  const limit = Math.max(1, options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS);
  const errors: string[] = [];

  if (isRuntimePlan(value)) {
    return collectRuntimePlanTemplateDiagnostics(value).slice(0, limit);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["The top-level structured payload must be an object"];
  }

  const plan = value as Record<string, unknown>;
  if (
    plan.id !== undefined &&
    (typeof plan.id !== "string" || plan.id.trim().length === 0)
  ) {
    errors.push("id must be a non-empty string when present");
  }
  if (
    plan.version !== undefined &&
    (typeof plan.version !== "number" ||
      !Number.isInteger(plan.version) ||
      plan.version <= 0)
  ) {
    errors.push("version must be a positive integer when present");
  }
  if (
    plan.specVersion !== undefined &&
    (typeof plan.specVersion !== "string" ||
      plan.specVersion.trim().length === 0)
  ) {
    errors.push("specVersion must be a non-empty string when present");
  }

  if (!Object.hasOwn(plan, "root")) {
    errors.push("root is required");
  } else if (!normalizeRuntimeNodeCandidate(plan.root)) {
    collectRuntimeNodeDiagnostics(plan.root, "root", errors, limit);
  }
  if (
    Object.hasOwn(plan, "capabilities") &&
    !isRuntimeCapabilities(plan.capabilities)
  ) {
    errors.push(
      "capabilities contains invalid values; omit unused entries or use the RuntimeCapabilities types",
    );
  }
  if (
    Object.hasOwn(plan, "imports") &&
    (!Array.isArray(plan.imports) ||
      plan.imports.some((entry) => typeof entry !== "string"))
  ) {
    errors.push("imports must be an array of strings");
  }
  if (
    Object.hasOwn(plan, "moduleManifest") &&
    !isRuntimeModuleManifest(plan.moduleManifest)
  ) {
    errors.push(
      "moduleManifest must map module specifiers to descriptors with a non-empty resolvedUrl",
    );
  }
  if (Object.hasOwn(plan, "state") && !isRuntimeStateModel(plan.state)) {
    errors.push(
      "state must contain an initial object and optional valid transitions; omit state when unused",
    );
  }
  if (Object.hasOwn(plan, "source")) {
    collectSourceDiagnostics(plan.source, errors);
  }
  if (
    Object.hasOwn(plan, "metadata") &&
    !isRuntimePlanMetadata(plan.metadata)
  ) {
    errors.push("metadata must contain only JSON values and string tags");
  }

  if (errors.length === 0) {
    errors.push(
      "The payload does not satisfy the RuntimePlan contract; check required fields and node shapes",
    );
  }
  return errors.slice(0, limit);
}

function collectSourceDiagnostics(source: unknown, errors: string[]): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    errors.push("source must be an object; omit source when unused");
    return;
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord.code !== "string" ||
    sourceRecord.code.trim().length === 0
  ) {
    errors.push("source.code must be a non-empty string");
  }
  if (!isRuntimeSourceLanguage(sourceRecord.language)) {
    errors.push('source.language must be "js", "jsx", "ts", or "tsx"');
  }
  if (
    sourceRecord.runtime !== undefined &&
    !isRuntimeSourceRuntime(sourceRecord.runtime)
  ) {
    errors.push(
      'source.runtime must be "renderify" or "preact"; omit source for declarative plans',
    );
  }
}

const NODE_KEYS: Record<string, ReadonlySet<string>> = {
  text: new Set(["type", "value"]),
  element: new Set(["type", "tag", "props", "children"]),
  component: new Set(["type", "module", "exportName", "props", "children"]),
};

const TOP_LEVEL_KEYS = new Set([
  "state",
  "capabilities",
  "imports",
  "moduleManifest",
  "source",
  "metadata",
]);

function collectRuntimeNodeDiagnostics(
  value: unknown,
  path: string,
  errors: string[],
  limit: number,
): void {
  if (errors.length >= limit) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be a RuntimeNode object`);
    return;
  }

  const node = value as Record<string, unknown>;
  if (typeof node.type !== "string") {
    errors.push(`${path}.type must be "text", "element", or "component"`);
    return;
  }

  const allowedKeys = NODE_KEYS[node.type];
  if (allowedKeys) {
    for (const key of Object.keys(node)) {
      if (
        allowedKeys.has(key) ||
        key === "style" ||
        (node.type === "text" && (key === "props" || key === "children"))
      ) {
        continue;
      }
      if (errors.length >= limit) {
        return;
      }
      const placementHint = TOP_LEVEL_KEYS.has(key)
        ? `; move ${key} to the RuntimePlan top level`
        : "";
      errors.push(
        `${path}.${key} is not valid on a RuntimeNode${placementHint}`,
      );
    }
  }

  if (node.type === "text") {
    if (typeof node.value !== "string") {
      errors.push(`${path}.value must be a string for a text node`);
    }
    if (Object.hasOwn(node, "style")) {
      errors.push(
        `${path}.style is invalid on a text node; wrap it in an element and use props.style`,
      );
    }
    if (Object.hasOwn(node, "props") || Object.hasOwn(node, "children")) {
      errors.push(`${path} text nodes only accept type and value`);
    }
    return;
  }

  if (node.type === "element") {
    if (typeof node.tag !== "string" || node.tag.trim().length === 0) {
      errors.push(`${path}.tag must be a non-empty string for an element node`);
    }
  } else if (node.type === "component") {
    if (typeof node.module !== "string" || node.module.trim().length === 0) {
      errors.push(
        `${path}.module must be a non-empty string for a component node`,
      );
    }
    if (
      node.exportName !== undefined &&
      (typeof node.exportName !== "string" ||
        node.exportName.trim().length === 0)
    ) {
      errors.push(`${path}.exportName must be a non-empty string when present`);
    }
  } else {
    errors.push(`${path}.type must be "text", "element", or "component"`);
    return;
  }

  if (
    node.props !== undefined &&
    (typeof node.props !== "object" ||
      node.props === null ||
      Array.isArray(node.props) ||
      !isJsonValue(node.props))
  ) {
    errors.push(`${path}.props must be an object containing JSON values`);
  }
  if (Object.hasOwn(node, "style")) {
    errors.push(`${path}.style must be nested under ${path}.props.style`);
  }
  if (node.children === undefined) {
    return;
  }
  if (!Array.isArray(node.children)) {
    errors.push(`${path}.children must be an array of RuntimeNode objects`);
    return;
  }
  for (let index = 0; index < node.children.length; index += 1) {
    if (errors.length >= limit) {
      return;
    }
    if (!normalizeRuntimeNodeCandidate(node.children[index])) {
      collectRuntimeNodeDiagnostics(
        node.children[index],
        `${path}.children[${index}]`,
        errors,
        limit,
      );
    }
  }
}
