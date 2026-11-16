/**
 * Interaction rules shared by the RuntimePlan validator, the runtime, and the
 * security checker: loop scopes, value references, templated state paths,
 * two-way `bind` paths, and condition semantics. Validation and execution
 * import the same functions, so a plan that validates behaves as validated.
 */
import {
  asJsonValue,
  isRuntimeTemplatePath,
  isRuntimeValueFromPath,
  isSafePath,
  type JsonValue,
  type RuntimeActionValue,
  type RuntimeEvent,
} from "./index";

/**
 * Event type the runtime dispatches when a form control with a `bind` prop
 * changes. Its payload is `{ path, value }`; the runtime writes `value` to
 * `path` in plan state before running any transitions for the event.
 */
export const RUNTIME_BIND_EVENT_TYPE = "renderify:bind";

export const DEFAULT_RUNTIME_EACH_ITEM_NAME = "item";
export const DEFAULT_RUNTIME_EACH_INDEX_NAME = "index";

/** Template roots that `each` loop variables may not shadow. */
export const RUNTIME_RESERVED_SCOPE_NAMES: readonly string[] = Object.freeze([
  "state",
  "event",
  "context",
  "vars",
]);

/** Loop variables visible to templates inside an `each` node. */
export type RuntimeTemplateScope = Readonly<Record<string, JsonValue>>;

const RUNTIME_SCOPE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RUNTIME_RESOLVED_SEGMENT_PATTERN = /^[A-Za-z0-9_$-]+$/;
const RUNTIME_EXACT_TEMPLATE_PATTERN = /^{{\s*([^{}]+?)\s*}}$/;
const RUNTIME_PATH_PLACEHOLDER_PATTERN = /^\0(\d+)\0$/;
const RUNTIME_NON_STATE_ROOT_PATTERN = /^(?:event|context|vars)\./;
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_VALUE_REFERENCE_DEPTH = 64;

/** Whether a value can name an `each` loop variable (`as` or `index`). */
export function isRuntimeScopeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RUNTIME_SCOPE_NAME_PATTERN.test(value) &&
    !RUNTIME_RESERVED_SCOPE_NAMES.includes(value) &&
    !UNSAFE_PATH_SEGMENTS.has(value)
  );
}

/**
 * Reads the path from a value reference used by `each.items` and `if.when`:
 * a bare path (`state.todos`) or a single exact template (`{{state.todos}}`).
 */
export function readRuntimeValueReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const exact = RUNTIME_EXACT_TEMPLATE_PATTERN.exec(trimmed);
  const path = (exact ? (exact[1] ?? "") : trimmed).trim();
  return isRuntimeTemplatePath(path) ? path : undefined;
}

/**
 * Condition truthiness for `if` nodes: JavaScript truthiness, except that an
 * empty array is false, so `when: "state.todos"` means "has todos".
 */
export function isRuntimeTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

/**
 * Equality for `if.equals`. Primitives compare by their string form, so a
 * number in state matches the same number captured from an input as text;
 * `null` and missing values only equal each other.
 */
export function areRuntimeValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) {
    return leftMissing && rightMissing;
  }
  if (isRuntimePrimitive(left) && isRuntimePrimitive(right)) {
    return String(left) === String(right);
  }
  if (typeof left === "object" && typeof right === "object") {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  return false;
}

type RuntimeStatePathSegment = { literal: string } | { expression: string };

function parseRuntimeStatePath(
  path: string,
): RuntimeStatePathSegment[] | undefined {
  if (path.includes("\0")) {
    return undefined;
  }
  const expressions: string[] = [];
  let invalidExpression = false;
  const masked = path.replace(/{{([^{}]*)}}/g, (_match, expression: string) => {
    const trimmed = expression.trim();
    if (!isRuntimeTemplatePath(trimmed)) {
      invalidExpression = true;
    }
    expressions.push(trimmed);
    return `\0${expressions.length - 1}\0`;
  });
  if (invalidExpression || masked.includes("{{") || masked.includes("}}")) {
    return undefined;
  }

  const segments: RuntimeStatePathSegment[] = [];
  for (const rawPart of masked.split(".")) {
    const part = rawPart.trim();
    if (part.length === 0) {
      return undefined;
    }
    const placeholder = RUNTIME_PATH_PLACEHOLDER_PATTERN.exec(part);
    if (placeholder) {
      segments.push({ expression: expressions[Number(placeholder[1])] ?? "" });
      continue;
    }
    // A template must fill a whole segment: "todo_{{index}}" is not allowed.
    if (part.includes("\0") || UNSAFE_PATH_SEGMENTS.has(part)) {
      return undefined;
    }
    segments.push({ literal: part });
  }
  return segments.length > 0 ? segments : undefined;
}

/**
 * Validates a state path that may contain whole-segment templates, such as
 * `todos.{{event.payload.index}}.done`.
 */
export function isRuntimeStatePathTemplate(path: string): boolean {
  return (
    typeof path === "string" &&
    isSafePath(path) &&
    parseRuntimeStatePath(path) !== undefined
  );
}

/**
 * Resolves a state path to a concrete path. Paths without templates are
 * returned unchanged when safe. Each template must resolve to a string or a
 * non-negative integer that forms one safe segment; dots, empty strings,
 * objects, and prototype keys make the whole path invalid.
 */
export function resolveRuntimeStatePath(
  path: string,
  resolveExpression: (expression: string) => unknown,
): string | undefined {
  if (!path.includes("{{")) {
    return isSafePath(path) ? path : undefined;
  }
  const segments = parseRuntimeStatePath(path);
  if (!segments) {
    return undefined;
  }

  const resolved: string[] = [];
  for (const segment of segments) {
    if ("literal" in segment) {
      resolved.push(segment.literal);
      continue;
    }
    const value = resolveExpression(segment.expression);
    const text =
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : undefined;
    if (
      text === undefined ||
      !RUNTIME_RESOLVED_SEGMENT_PATTERN.test(text) ||
      UNSAFE_PATH_SEGMENTS.has(text)
    ) {
      return undefined;
    }
    resolved.push(text);
  }
  return resolved.join(".");
}

function stripStatePrefix(path: string): string | undefined {
  const trimmed = path.trim();
  if (RUNTIME_NON_STATE_ROOT_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("state.") ? trimmed.slice(6) : trimmed;
}

/**
 * Validates a `bind` prop as written in a plan: a state path (the `state.`
 * prefix is optional) that may contain whole-segment loop templates, such as
 * `todos.{{index}}.done`.
 */
export function isRuntimeBindPathTemplate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const path = stripStatePrefix(value);
  return path !== undefined && isRuntimeStatePathTemplate(path);
}

/**
 * Normalizes a rendered `bind` prop (templates already resolved) to the
 * concrete state path the runtime writes.
 */
export function normalizeRuntimeBindPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const path = stripStatePrefix(value);
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  const segments = path.split(".");
  for (const segment of segments) {
    if (
      !RUNTIME_RESOLVED_SEGMENT_PATTERN.test(segment) ||
      UNSAFE_PATH_SEGMENTS.has(segment)
    ) {
      return undefined;
    }
  }
  return segments.join(".");
}

/**
 * Replaces every `{"$from": path}` reference inside a JSON value. References
 * resolve once: resolved data is copied and never re-scanned.
 */
export function resolveRuntimeValueReferences(
  value: RuntimeActionValue,
  resolve: (path: string) => unknown,
): JsonValue {
  return resolveValueReferencesInternal(value as JsonValue, resolve, 0).value;
}

/**
 * Resolves `{"$from"}` references in an event payload against the state at
 * dispatch time. A payload that is itself one reference is replaced by the
 * referenced object (or `{ value }` for a non-object). Returns the same event
 * object when the payload contains no references.
 */
export function resolveRuntimeEventReferences(
  event: RuntimeEvent,
  resolve: (path: string) => unknown,
): RuntimeEvent {
  const payload = event.payload;
  if (!payload) {
    return event;
  }
  if (isRuntimeValueFromPath(payload)) {
    const resolved = asJsonValue(resolve(payload.$from));
    return {
      ...event,
      payload: isPlainObject(resolved)
        ? (resolved as Record<string, JsonValue>)
        : { value: resolved },
    };
  }
  const result = resolveValueReferencesInternal(payload, resolve, 0);
  return result.changed
    ? { ...event, payload: result.value as Record<string, JsonValue> }
    : event;
}

/** Lists the `$from` paths referenced anywhere inside a JSON value. */
export function collectRuntimeValueReferences(
  value: RuntimeActionValue,
): string[] {
  const references: string[] = [];
  const pending: Array<{ value: JsonValue; depth: number }> = [
    { value: value as JsonValue, depth: 0 },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || entry.depth > MAX_VALUE_REFERENCE_DEPTH) {
      continue;
    }
    if (isRuntimeValueFromPath(entry.value)) {
      references.push(entry.value.$from);
      continue;
    }
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
      continue;
    }
    if (isPlainObject(entry.value)) {
      for (const item of Object.values(entry.value)) {
        pending.push({ value: item as JsonValue, depth: entry.depth + 1 });
      }
    }
  }
  return references;
}

function resolveValueReferencesInternal(
  value: JsonValue,
  resolve: (path: string) => unknown,
  depth: number,
): { value: JsonValue; changed: boolean } {
  if (isRuntimeValueFromPath(value)) {
    return { value: asJsonValue(resolve(value.$from)), changed: true };
  }
  if (depth >= MAX_VALUE_REFERENCE_DEPTH) {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = resolveValueReferencesInternal(item, resolve, depth + 1);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = resolveValueReferencesInternal(
        item as JsonValue,
        resolve,
        depth + 1,
      );
      changed ||= result.changed;
      // defineProperty keeps a JSON "__proto__" key as plain data.
      Object.defineProperty(next, key, {
        value: result.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

function isRuntimePrimitive(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
