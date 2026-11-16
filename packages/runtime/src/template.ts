import {
  asJsonValue,
  getValueByPath,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeStateSnapshot,
  type RuntimeTemplateScope,
} from "@renderify/ir";

const TEMPLATE_STRINGIFY_MAX_DEPTH = 8;
const TEMPLATE_STRINGIFY_MAX_NODES = 256;
const TEMPLATE_STRINGIFY_MAX_LENGTH = 4096;
const TEMPLATE_TRUNCATED_MARKER = "[Truncated]";
const TEMPLATE_CIRCULAR = Symbol("renderify-template-circular");
const EXACT_TEMPLATE_EXPRESSION_PATTERN = /^{{\s*([^{}]+?)\s*}}$/;

export function resolveProps(
  props: Record<string, JsonValue> | undefined,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope?: RuntimeTemplateScope,
): Record<string, JsonValue> | undefined {
  if (!props) {
    return undefined;
  }

  const resolved: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolveJsonValue(value, context, state, event, scope);
  }

  return resolved;
}

export function resolveJsonValue(
  value: JsonValue,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope?: RuntimeTemplateScope,
): JsonValue {
  return resolveJsonValueInternal(
    value,
    context,
    state,
    event,
    scope,
    new WeakSet(),
  );
}

function resolveJsonValueInternal(
  value: JsonValue,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope: RuntimeTemplateScope | undefined,
  seen: WeakSet<object>,
): JsonValue {
  if (typeof value === "string") {
    return resolveTemplateValue(value, context, state, event, scope);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    const resolved = value.map((item) =>
      resolveJsonValueInternal(item, context, state, event, scope, seen),
    );
    seen.delete(value);
    return resolved;
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    const resolved: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveJsonValueInternal(
        item,
        context,
        state,
        event,
        scope,
        seen,
      );
    }
    seen.delete(value);
    return resolved;
  }

  return value;
}

function resolveTemplateValue(
  template: string,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope: RuntimeTemplateScope | undefined,
): JsonValue {
  const exactExpression = EXACT_TEMPLATE_EXPRESSION_PATTERN.exec(template);
  if (!exactExpression) {
    return interpolateTemplate(template, context, state, event, scope);
  }

  const resolved = resolveTemplateExpression(
    exactExpression[1] ?? "",
    context,
    state,
    event,
    scope,
  );
  return resolved === undefined || resolved === null
    ? ""
    : asJsonValue(resolved);
}

export function interpolateTemplate(
  template: string,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope?: RuntimeTemplateScope,
): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, expression) => {
    const resolved = resolveTemplateExpression(
      expression,
      context,
      state,
      event,
      scope,
    );
    if (resolved === undefined || resolved === null) {
      return "";
    }

    if (typeof resolved === "object") {
      return serializeTemplateObject(resolved);
    }

    return String(resolved);
  });
}

function serializeTemplateObject(value: object): string {
  const normalized = toTemplateSerializable(value, 0, new WeakSet(), {
    nodes: 0,
  });
  if (normalized === TEMPLATE_CIRCULAR || normalized === undefined) {
    return "";
  }

  try {
    const serialized = JSON.stringify(normalized);
    if (typeof serialized !== "string") {
      return "";
    }

    if (serialized.length > TEMPLATE_STRINGIFY_MAX_LENGTH) {
      return `${serialized.slice(0, TEMPLATE_STRINGIFY_MAX_LENGTH)}...`;
    }

    return serialized;
  } catch {
    return "";
  }
}

function toTemplateSerializable(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { nodes: number },
): unknown | typeof TEMPLATE_CIRCULAR | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return TEMPLATE_CIRCULAR;
  }

  if (
    depth >= TEMPLATE_STRINGIFY_MAX_DEPTH ||
    budget.nodes >= TEMPLATE_STRINGIFY_MAX_NODES
  ) {
    return TEMPLATE_TRUNCATED_MARKER;
  }

  seen.add(value);
  budget.nodes += 1;

  if (Array.isArray(value)) {
    const normalizedArray: unknown[] = [];
    for (const entry of value) {
      const normalized = toTemplateSerializable(entry, depth + 1, seen, budget);
      if (normalized === TEMPLATE_CIRCULAR) {
        seen.delete(value);
        return TEMPLATE_CIRCULAR;
      }
      normalizedArray.push(normalized === undefined ? null : normalized);
    }
    seen.delete(value);
    return normalizedArray;
  }

  const normalizedRecord: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = toTemplateSerializable(entry, depth + 1, seen, budget);
    if (normalized === TEMPLATE_CIRCULAR) {
      seen.delete(value);
      return TEMPLATE_CIRCULAR;
    }

    if (normalized !== undefined) {
      normalizedRecord[key] = normalized;
    }
  }

  seen.delete(value);
  return normalizedRecord;
}

/**
 * Resolves one template path. `state.`, `event.`, `context.`, and `vars.`
 * roots come first; inside `each` loops the loop variables are next; any
 * other path reads plan state.
 */
export function resolveTemplateExpression(
  expression: string,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  scope?: RuntimeTemplateScope,
): unknown {
  const path = expression.trim();

  if (path.startsWith("state.")) {
    return getValueByPath(state, path.slice(6));
  }

  if (path.startsWith("event.")) {
    return getValueByPath(event, path.slice(6));
  }

  if (path.startsWith("context.")) {
    return getValueByPath(context, path.slice(8));
  }

  if (path.startsWith("vars.")) {
    return getValueByPath(context.variables, path.slice(5));
  }

  if (scope) {
    const separator = path.indexOf(".");
    const head = separator === -1 ? path : path.slice(0, separator);
    if (Object.hasOwn(scope, head)) {
      return separator === -1
        ? scope[head]
        : getValueByPath(scope[head], path.slice(separator + 1));
    }
  }

  return getValueByPath(state, path);
}
