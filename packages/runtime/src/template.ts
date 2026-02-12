import {
  getValueByPath,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeStateSnapshot,
} from "@renderify/ir";

const TEMPLATE_STRINGIFY_MAX_DEPTH = 8;
const TEMPLATE_STRINGIFY_MAX_NODES = 256;
const TEMPLATE_STRINGIFY_MAX_LENGTH = 4096;
const TEMPLATE_TRUNCATED_MARKER = "[Truncated]";
const TEMPLATE_CIRCULAR = Symbol("renderify-template-circular");

export function resolveProps(
  props: Record<string, JsonValue> | undefined,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
): Record<string, JsonValue> | undefined {
  if (!props) {
    return undefined;
  }

  const resolved: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolveJsonValue(value, context, state, event);
  }

  return resolved;
}

export function resolveJsonValue(
  value: JsonValue,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
): JsonValue {
  return resolveJsonValueInternal(value, context, state, event, new WeakSet());
}

function resolveJsonValueInternal(
  value: JsonValue,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
  seen: WeakSet<object>,
): JsonValue {
  if (typeof value === "string") {
    return interpolateTemplate(value, context, state, event);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    const resolved = value.map((item) =>
      resolveJsonValueInternal(item, context, state, event, seen),
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
        seen,
      );
    }
    seen.delete(value);
    return resolved;
  }

  return value;
}

export function interpolateTemplate(
  template: string,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, expression) => {
    const resolved = resolveExpression(expression, context, state, event);
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

function resolveExpression(
  expression: string,
  context: RuntimeExecutionContext,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent | undefined,
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

  return getValueByPath(state, path);
}
