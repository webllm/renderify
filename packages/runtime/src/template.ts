import {
  getValueByPath,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeStateSnapshot,
} from "@renderify/ir";

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
  if (typeof value === "string") {
    return interpolateTemplate(value, context, state, event);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveJsonValue(item, context, state, event));
  }

  if (value !== null && typeof value === "object") {
    const resolved: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveJsonValue(item, context, state, event);
    }
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
      return JSON.stringify(resolved);
    }

    return String(resolved);
  });
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
