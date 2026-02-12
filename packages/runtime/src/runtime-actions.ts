import {
  asJsonValue,
  getValueByPath,
  isRuntimeValueFromPath,
  type JsonValue,
  type RuntimeAction,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeStateSnapshot,
  setValueByPath,
} from "@renderify/ir";

export function applyRuntimeAction(
  action: RuntimeAction,
  state: RuntimeStateSnapshot,
  event: RuntimeEvent,
  context: RuntimeExecutionContext,
): void {
  if (action.type === "set") {
    const next = resolveRuntimeActionValue(action.value, state, event, context);
    setValueByPath(state, action.path, next);
    return;
  }

  if (action.type === "increment") {
    const current = getValueByPath(state, action.path);
    const currentNumber = typeof current === "number" ? current : 0;
    const by = action.by ?? 1;
    setValueByPath(state, action.path, asJsonValue(currentNumber + by));
    return;
  }

  if (action.type === "toggle") {
    const current = getValueByPath(state, action.path);
    const next = typeof current === "boolean" ? !current : true;
    setValueByPath(state, action.path, next);
    return;
  }

  const next = resolveRuntimeActionValue(action.value, state, event, context);
  const current = getValueByPath(state, action.path);

  if (Array.isArray(current)) {
    setValueByPath(state, action.path, [...current, next]);
    return;
  }

  setValueByPath(state, action.path, [next]);
}

export function resolveRuntimeActionValue(
  value: JsonValue | { $from: string },
  state: RuntimeStateSnapshot,
  event: RuntimeEvent,
  context: RuntimeExecutionContext,
): JsonValue {
  if (!isRuntimeValueFromPath(value)) {
    return value;
  }

  const sourcePath = value.$from.trim();
  if (sourcePath.startsWith("state.")) {
    return asJsonValue(getValueByPath(state, sourcePath.slice(6)));
  }

  if (sourcePath.startsWith("event.")) {
    return asJsonValue(getValueByPath(event, sourcePath.slice(6)));
  }

  if (sourcePath.startsWith("context.")) {
    return asJsonValue(getValueByPath(context, sourcePath.slice(8)));
  }

  if (sourcePath.startsWith("vars.")) {
    return asJsonValue(getValueByPath(context.variables, sourcePath.slice(5)));
  }

  return asJsonValue(getValueByPath(state, sourcePath));
}
