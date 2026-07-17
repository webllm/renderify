export type JsonPrimitive = string | number | boolean | null;

export {
  createFnv1a64Hasher,
  type Fnv1a64Hasher,
  hashStringFNV1a32,
  hashStringFNV1a32Base36,
  hashStringFNV1a64Hex,
} from "./hash";
export {
  collectRuntimeSourceImports,
  parseRuntimeSourceImportRanges,
  type RuntimeSourceImportRange,
} from "./source-imports";

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RuntimeTextNode {
  type: "text";
  value: string;
}

export interface RuntimeElementNode {
  type: "element";
  tag: string;
  props?: Record<string, JsonValue>;
  children?: RuntimeNode[];
}

export interface RuntimeComponentNode {
  type: "component";
  module: string;
  exportName?: string;
  props?: Record<string, JsonValue>;
  children?: RuntimeNode[];
}

export type RuntimeNode =
  | RuntimeTextNode
  | RuntimeElementNode
  | RuntimeComponentNode;

export type RuntimeExecutionProfile =
  | "standard"
  | "isolated-vm"
  | "sandbox-worker"
  | "sandbox-iframe"
  | "sandbox-shadowrealm";

export const DEFAULT_JSPM_SPECIFIER_OVERRIDES: Readonly<
  Record<string, string>
> = Object.freeze({
  preact: "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  "preact/hooks":
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
  "preact/compat":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "preact/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  react: "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom/client":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  "react/jsx-dev-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  recharts: "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
});

export type RuntimeSourceLanguage = "js" | "jsx" | "ts" | "tsx";
export type RuntimeSourceRuntime = "renderify" | "preact";

export interface RuntimeSourceModule {
  code: string;
  language: RuntimeSourceLanguage;
  exportName?: string;
  runtime?: RuntimeSourceRuntime;
}

export const RUNTIME_PLAN_SPEC_VERSION_V1 = "runtime-plan/v1";
export const DEFAULT_RUNTIME_PLAN_SPEC_VERSION = RUNTIME_PLAN_SPEC_VERSION_V1;

export type RuntimePlanSpecVersion = typeof RUNTIME_PLAN_SPEC_VERSION_V1;

export interface RuntimeModuleDescriptor {
  resolvedUrl: string;
  integrity?: string;
  version?: string;
  signer?: string;
}

export type RuntimeModuleManifest = Record<string, RuntimeModuleDescriptor>;

export interface RuntimeCapabilities {
  domWrite?: boolean;
  networkHosts?: string[];
  allowedModules?: string[];
  timers?: boolean;
  storage?: Array<"localStorage" | "sessionStorage">;
  executionProfile?: RuntimeExecutionProfile;
  maxImports?: number;
  maxComponentInvocations?: number;
  maxExecutionMs?: number;
}

export interface RuntimeValueFromPath {
  $from: string;
}

export type RuntimeActionValue = JsonValue | RuntimeValueFromPath;

export interface RuntimeSetAction {
  type: "set";
  path: string;
  value: RuntimeActionValue;
}

export interface RuntimeIncrementAction {
  type: "increment";
  path: string;
  by?: number;
}

export interface RuntimeToggleAction {
  type: "toggle";
  path: string;
}

export interface RuntimePushAction {
  type: "push";
  path: string;
  value: RuntimeActionValue;
}

export type RuntimeAction =
  | RuntimeSetAction
  | RuntimeIncrementAction
  | RuntimeToggleAction
  | RuntimePushAction;

export interface RuntimeEvent {
  type: string;
  payload?: Record<string, JsonValue>;
}

export type RuntimeStateSnapshot = Record<string, JsonValue>;

export interface RuntimeStateModel {
  initial: RuntimeStateSnapshot;
  transitions?: Record<string, RuntimeAction[]>;
}

export interface RuntimePlanMetadata {
  sourcePrompt?: string;
  sourceModel?: string;
  tags?: string[];
  [key: string]: JsonValue | undefined;
}

export interface RuntimePlan {
  specVersion?: string;
  id: string;
  version: number;
  root: RuntimeNode;
  capabilities?: RuntimeCapabilities;
  state?: RuntimeStateModel;
  imports?: string[];
  moduleManifest?: RuntimeModuleManifest;
  source?: RuntimeSourceModule;
  metadata?: RuntimePlanMetadata;
}

export interface RuntimePlanNormalizationOptions {
  fallbackId?: string;
}

export interface RuntimeExecutionContext {
  userId?: string;
  variables?: Record<string, JsonValue>;
}

export interface RuntimeDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export type RuntimeRenderArtifactMode = "preact-vnode";

export interface RuntimeRenderArtifact {
  mode: RuntimeRenderArtifactMode;
  payload: unknown;
}

export interface RuntimeExecutionResult {
  planId: string;
  root: RuntimeNode;
  diagnostics: RuntimeDiagnostic[];
  state?: RuntimeStateSnapshot;
  handledEvent?: RuntimeEvent;
  appliedActions?: RuntimeAction[];
  renderArtifact?: RuntimeRenderArtifact;
}

export function createTextNode(value: string): RuntimeTextNode {
  return { type: "text", value };
}

export function createElementNode(
  tag: string,
  props?: Record<string, JsonValue>,
  children?: RuntimeNode[],
): RuntimeElementNode {
  return { type: "element", tag, props, children };
}

export function createComponentNode(
  module: string,
  exportName = "default",
  props?: Record<string, JsonValue>,
  children?: RuntimeNode[],
): RuntimeComponentNode {
  return { type: "component", module, exportName, props, children };
}

export function isRuntimeNode(value: unknown): value is RuntimeNode {
  const pending: Array<{ value: unknown; exiting: boolean }> = [
    { value, exiting: false },
  ];
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || typeof entry.value !== "object" || entry.value === null) {
      return false;
    }

    if (entry.exiting) {
      active.delete(entry.value);
      completed.add(entry.value);
      continue;
    }

    if (completed.has(entry.value)) {
      continue;
    }
    if (active.has(entry.value)) {
      return false;
    }

    const shape = inspectRuntimeNodeShape(entry.value);
    if (!shape) {
      return false;
    }

    active.add(entry.value);
    pending.push({ value: entry.value, exiting: true });
    for (let index = shape.children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: shape.children[index], exiting: false });
    }
  }

  return true;
}

const RUNTIME_NODE_NORMALIZATION_MAX_DEPTH = 512;
const RUNTIME_NODE_NORMALIZATION_MAX_NODES = 10_000;
const RUNTIME_NODE_TAG_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RUNTIME_NODE_NORMALIZATION_ALIAS_KEYS = [
  "nodes",
  "text",
  "style",
  "id",
  "title",
  "role",
  "for",
  "htmlFor",
  "class",
  "className",
] as const;

interface RuntimeNodeNormalizationState {
  active: WeakSet<object>;
  nodes: number;
}

/**
 * Converts the common DOM-like JSON shape emitted by LLMs into RuntimeNode.
 * The conversion is deliberately bounded and only accepts JSON values.
 */
export function normalizeRuntimeNodeCandidate(
  value: unknown,
): RuntimeNode | undefined {
  if (!isRuntimeNormalizationDataTree(value)) {
    return undefined;
  }
  if (isRuntimeNode(value)) {
    return value;
  }

  return normalizeRuntimeNodeCandidateInternal(
    value,
    {
      active: new WeakSet<object>(),
      nodes: 0,
    },
    0,
  );
}

function normalizeRuntimeNodeCandidateInternal(
  value: unknown,
  state: RuntimeNodeNormalizationState,
  depth: number,
): RuntimeNode | undefined {
  if (depth > RUNTIME_NODE_NORMALIZATION_MAX_DEPTH) {
    return undefined;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    state.nodes += 1;
    return state.nodes <= RUNTIME_NODE_NORMALIZATION_MAX_NODES
      ? createTextNode(String(value))
      : undefined;
  }

  if (!isPlainJsonObject(value) || state.active.has(value)) {
    return undefined;
  }

  state.nodes += 1;
  if (state.nodes > RUNTIME_NODE_NORMALIZATION_MAX_NODES) {
    return undefined;
  }

  state.active.add(value);
  try {
    const typeProperty = readOwnDataProperty(value, "type");
    if (
      !typeProperty ||
      (typeProperty.present &&
        (typeof typeProperty.value !== "string" ||
          typeProperty.value.trim().length === 0))
    ) {
      return undefined;
    }
    const typeValue = typeProperty.value;
    const legacyTextProperty = readOwnDataProperty(value, "text");
    if (!legacyTextProperty) {
      return undefined;
    }
    if (typeValue === "text") {
      const runtimeValueProperty = readOwnDataProperty(value, "value");
      if (
        !runtimeValueProperty ||
        (runtimeValueProperty.present &&
          typeof runtimeValueProperty.value !== "string") ||
        (legacyTextProperty.present &&
          typeof legacyTextProperty.value !== "string")
      ) {
        return undefined;
      }

      const normalizedProps = normalizeRuntimeNodeCandidateProps(value);
      const runtimeChildrenProperty = readOwnDataProperty(value, "children");
      const legacyNodesProperty = readOwnDataProperty(value, "nodes");
      if (
        !normalizedProps.valid ||
        normalizedProps.value !== undefined ||
        !runtimeChildrenProperty ||
        !legacyNodesProperty ||
        runtimeChildrenProperty.present ||
        legacyNodesProperty.present
      ) {
        return undefined;
      }

      const runtimeValue = runtimeValueProperty.value;
      const legacyText = legacyTextProperty.value;
      if (
        typeof runtimeValue === "string" &&
        typeof legacyText === "string" &&
        runtimeValue !== legacyText
      ) {
        return undefined;
      }
      const text =
        typeof runtimeValue === "string"
          ? runtimeValue
          : typeof legacyText === "string"
            ? legacyText
            : undefined;
      return text === undefined ? undefined : createTextNode(text);
    }

    if (legacyTextProperty.present) {
      return undefined;
    }

    const children = normalizeRuntimeNodeCandidateChildren(value, state, depth);
    if (!children) {
      return undefined;
    }

    const normalizedProps = normalizeRuntimeNodeCandidateProps(value);
    if (!normalizedProps.valid) {
      return undefined;
    }
    const props = normalizedProps.value;
    if (typeValue === "component") {
      const moduleProperty = readOwnDataProperty(value, "module");
      const exportProperty = readOwnDataProperty(value, "exportName");
      if (!moduleProperty || !exportProperty) {
        return undefined;
      }
      const moduleValue = moduleProperty.value;
      const exportValue = exportProperty.value;
      if (
        typeof moduleValue !== "string" ||
        moduleValue.trim().length === 0 ||
        (exportValue !== undefined &&
          (typeof exportValue !== "string" || exportValue.trim().length === 0))
      ) {
        return undefined;
      }

      const component: RuntimeComponentNode = {
        type: "component",
        module: moduleValue.trim(),
        exportName:
          typeof exportValue === "string" ? exportValue.trim() : "default",
        children,
      };
      if (props) {
        component.props = props;
      }
      return component;
    }

    const explicitTagProperty = readOwnDataProperty(value, "tag");
    if (
      !explicitTagProperty ||
      (explicitTagProperty.present &&
        (typeof explicitTagProperty.value !== "string" ||
          explicitTagProperty.value.trim().length === 0))
    ) {
      return undefined;
    }
    const explicitTag = explicitTagProperty.value;
    const inferredTag =
      typeof typeValue === "string" &&
      RUNTIME_NODE_TAG_NAME_PATTERN.test(typeValue)
        ? typeValue
        : undefined;
    let tag: string | undefined;
    if (typeValue === "element") {
      tag = typeof explicitTag === "string" ? explicitTag.trim() : undefined;
    } else if (typeValue === "container") {
      tag =
        typeof explicitTag === "string" && explicitTag.trim().length > 0
          ? explicitTag.trim()
          : "div";
    } else if (!inferredTag) {
      return undefined;
    } else if (typeof explicitTag === "string") {
      if (explicitTag.trim() !== inferredTag) {
        return undefined;
      }
      tag = inferredTag;
    } else {
      tag = inferredTag;
    }

    if (!tag) {
      return undefined;
    }

    const element: RuntimeElementNode = {
      type: "element",
      tag,
      children,
    };
    if (props) {
      element.props = props;
    }
    return element;
  } finally {
    state.active.delete(value);
  }
}

function normalizeRuntimeNodeCandidateChildren(
  value: Record<string, unknown>,
  state: RuntimeNodeNormalizationState,
  depth: number,
): RuntimeNode[] | undefined {
  const runtimeChildren = readOwnDataProperty(value, "children");
  const legacyNodes = readOwnDataProperty(value, "nodes");
  if (
    !runtimeChildren ||
    !legacyNodes ||
    (runtimeChildren.present && legacyNodes.present)
  ) {
    return undefined;
  }
  const rawChildren = runtimeChildren?.present
    ? runtimeChildren.value
    : legacyNodes?.present
      ? legacyNodes.value
      : undefined;

  if (rawChildren === undefined) {
    return [];
  }
  if (!Array.isArray(rawChildren)) {
    return undefined;
  }
  const childCandidates = readOwnDataArrayValues(rawChildren);
  if (!childCandidates) {
    return undefined;
  }

  const children: RuntimeNode[] = [];
  for (const child of childCandidates) {
    const normalized = normalizeRuntimeNodeCandidateInternal(
      child,
      state,
      depth + 1,
    );
    if (!normalized) {
      return undefined;
    }
    children.push(normalized);
  }
  return children;
}

type RuntimeNodeCandidatePropsResult =
  | { valid: false }
  | { valid: true; value: Record<string, JsonValue> | undefined };

function normalizeRuntimeNodeCandidateProps(
  value: Record<string, unknown>,
): RuntimeNodeCandidatePropsResult {
  const rawPropsProperty = readOwnDataProperty(value, "props");
  if (!rawPropsProperty) {
    return { valid: false };
  }

  const rawProps = rawPropsProperty.value;
  if (
    rawPropsProperty.present &&
    rawProps !== undefined &&
    (!isPlainJsonObject(rawProps) || !isJsonValue(rawProps))
  ) {
    return { valid: false };
  }

  const props: Record<string, JsonValue> = rawPropsProperty.present
    ? { ...(rawProps as Record<string, JsonValue> | undefined) }
    : {};
  const rawStyleProperty = readOwnDataProperty(value, "style");
  if (!rawStyleProperty) {
    return { valid: false };
  }
  if (rawStyleProperty.present && rawStyleProperty.value !== undefined) {
    const rawStyle = rawStyleProperty.value;
    if (
      typeof rawStyle !== "string" &&
      (!isPlainJsonObject(rawStyle) || !isJsonValue(rawStyle))
    ) {
      return { valid: false };
    }
    if (props.style === undefined) {
      props.style = rawStyle;
    }
  }

  for (const key of ["id", "title", "role", "for", "class"] as const) {
    const property = readOwnDataProperty(value, key);
    if (
      !property ||
      (property.present &&
        property.value !== undefined &&
        typeof property.value !== "string")
    ) {
      return { valid: false };
    }
    const candidate = property.value;
    if (props[key] === undefined && typeof candidate === "string") {
      props[key] = candidate;
    }
  }

  const classNameProperty = readOwnDataProperty(value, "className");
  if (
    !classNameProperty ||
    (classNameProperty.present &&
      classNameProperty.value !== undefined &&
      typeof classNameProperty.value !== "string")
  ) {
    return { valid: false };
  }
  const className = classNameProperty.value;
  if (props.class === undefined && typeof className === "string") {
    props.class = className;
  }

  const htmlForProperty = readOwnDataProperty(value, "htmlFor");
  if (
    !htmlForProperty ||
    (htmlForProperty.present &&
      htmlForProperty.value !== undefined &&
      typeof htmlForProperty.value !== "string")
  ) {
    return { valid: false };
  }
  const htmlFor = htmlForProperty.value;
  if (props.for === undefined && typeof htmlFor === "string") {
    props.for = htmlFor;
  }

  return {
    valid: true,
    value: Object.keys(props).length > 0 ? props : undefined,
  };
}

export function isRuntimeNodeShallow(value: unknown): value is RuntimeNode {
  return inspectRuntimeNodeShape(value) !== undefined;
}

interface RuntimeNodeShape {
  node: RuntimeNode;
  children: unknown[];
}

function inspectRuntimeNodeShape(value: unknown): RuntimeNodeShape | undefined {
  if (!isPlainJsonObject(value)) {
    return undefined;
  }
  if (hasRuntimeNodeNormalizationAlias(value)) {
    return undefined;
  }

  const type = readOwnDataProperty(value, "type");
  if (!type?.present || typeof type.value !== "string") {
    return undefined;
  }

  if (type.value === "text") {
    const text = readOwnDataProperty(value, "value");
    const props = readOwnDataProperty(value, "props");
    const children = readOwnDataProperty(value, "children");
    return text?.present &&
      typeof text.value === "string" &&
      props &&
      !props.present &&
      children &&
      !children.present
      ? { node: value as unknown as RuntimeTextNode, children: [] }
      : undefined;
  }

  const props = readOwnDataProperty(value, "props");
  if (
    !props ||
    (props.present &&
      props.value !== undefined &&
      (!isPlainJsonObject(props.value) || !isJsonValue(props.value)))
  ) {
    return undefined;
  }

  const children = readRuntimeNodeChildren(value);
  if (!children) {
    return undefined;
  }

  if (type.value === "element") {
    const tag = readOwnDataProperty(value, "tag");
    return tag?.present &&
      typeof tag.value === "string" &&
      tag.value.trim().length > 0
      ? { node: value as unknown as RuntimeElementNode, children }
      : undefined;
  }

  if (type.value === "component") {
    const module = readOwnDataProperty(value, "module");
    if (
      !module?.present ||
      typeof module.value !== "string" ||
      module.value.trim().length === 0
    ) {
      return undefined;
    }

    const exportName = readOwnDataProperty(value, "exportName");
    if (
      !exportName ||
      (exportName.present &&
        exportName.value !== undefined &&
        (typeof exportName.value !== "string" ||
          exportName.value.trim().length === 0))
    ) {
      return undefined;
    }

    return { node: value as unknown as RuntimeComponentNode, children };
  }

  return undefined;
}

function hasRuntimeNodeNormalizationAlias(
  value: Record<string, unknown>,
): boolean {
  try {
    return RUNTIME_NODE_NORMALIZATION_ALIAS_KEYS.some((key) =>
      Object.hasOwn(value, key),
    );
  } catch {
    return true;
  }
}

function readRuntimeNodeChildren(
  value: Record<string, unknown>,
): unknown[] | undefined {
  const property = readOwnDataProperty(value, "children");
  if (!property) {
    return undefined;
  }
  if (!property.present || property.value === undefined) {
    return [];
  }
  if (!Array.isArray(property.value)) {
    return undefined;
  }

  return readOwnDataArrayValues(property.value);
}

function readOwnDataArrayValues(value: unknown[]): unknown[] | undefined {
  const children: unknown[] = [];
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        return undefined;
      }
      children.push(descriptor.value);
    }
  } catch {
    return undefined;
  }
  return children;
}

function isRuntimeNormalizationDataTree(value: unknown): boolean {
  const pending: Array<{ value: unknown; exiting: boolean }> = [
    { value, exiting: false },
  ];
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      return false;
    }

    if (entry.exiting) {
      if (typeof entry.value === "object" && entry.value !== null) {
        active.delete(entry.value);
        completed.add(entry.value);
      }
      continue;
    }

    if (
      entry.value === null ||
      entry.value === undefined ||
      typeof entry.value === "string" ||
      typeof entry.value === "boolean"
    ) {
      continue;
    }
    if (typeof entry.value === "number") {
      if (!Number.isFinite(entry.value)) {
        return false;
      }
      continue;
    }
    if (typeof entry.value !== "object") {
      return false;
    }

    if (completed.has(entry.value)) {
      continue;
    }
    if (active.has(entry.value)) {
      return false;
    }

    const arrayValue = Array.isArray(entry.value) ? entry.value : undefined;
    const isArray = arrayValue !== undefined;
    if (!isArray && !isPlainJsonObject(entry.value)) {
      return false;
    }

    const childValues: unknown[] = [];
    try {
      const keys = Reflect.ownKeys(entry.value);
      if (keys.some((key) => typeof key === "symbol")) {
        return false;
      }

      if (arrayValue) {
        for (let index = 0; index < arrayValue.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            arrayValue,
            String(index),
          );
          if (!descriptor || !("value" in descriptor)) {
            return false;
          }
        }
      }

      for (const key of keys) {
        if (isArray && key === "length") {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry.value, key);
        if (!descriptor || !("value" in descriptor)) {
          return false;
        }
        childValues.push(descriptor.value);
      }
    } catch {
      return false;
    }

    active.add(entry.value);
    pending.push({ value: entry.value, exiting: true });
    for (let index = childValues.length - 1; index >= 0; index -= 1) {
      pending.push({ value: childValues[index], exiting: false });
    }
  }

  return true;
}

function readOwnDataProperty(
  value: Record<string, unknown>,
  key: string,
): { present: boolean; value: unknown } | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return { present: false, value: undefined };
    }
    return "value" in descriptor
      ? { present: true, value: descriptor.value }
      : undefined;
  } catch {
    return undefined;
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>());
}

export function isRuntimeValueFromPath(
  value: unknown,
): value is RuntimeValueFromPath {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimeValueFromPath>;
  return typeof candidate.$from === "string";
}

export function isRuntimeAction(value: unknown): value is RuntimeAction {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.path !== "string" || value.path.trim().length === 0) {
    return false;
  }

  if (value.type === "set" || value.type === "push") {
    return (
      "value" in value &&
      (isJsonValue(value.value) || isRuntimeValueFromPath(value.value))
    );
  }

  if (value.type === "increment") {
    return (
      value.by === undefined ||
      (typeof value.by === "number" && Number.isFinite(value.by))
    );
  }

  if (value.type === "toggle") {
    return true;
  }

  return false;
}

export function isRuntimeStateSnapshot(
  value: unknown,
): value is RuntimeStateSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (!isJsonValue(entry)) {
      return false;
    }
  }

  return true;
}

export function isRuntimeStateModel(
  value: unknown,
): value is RuntimeStateModel {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRuntimeStateSnapshot(value.initial)) {
    return false;
  }

  if (value.transitions === undefined) {
    return true;
  }

  if (!isRecord(value.transitions)) {
    return false;
  }

  for (const [eventType, actions] of Object.entries(value.transitions)) {
    if (eventType.trim().length === 0) {
      return false;
    }

    if (!Array.isArray(actions)) {
      return false;
    }

    for (const action of actions) {
      if (!isRuntimeAction(action)) {
        return false;
      }
    }
  }

  return true;
}

export function isRuntimeCapabilities(
  value: unknown,
): value is RuntimeCapabilities {
  if (!isRecord(value)) {
    return false;
  }

  if (value.domWrite !== undefined && typeof value.domWrite !== "boolean") {
    return false;
  }

  if (
    value.networkHosts !== undefined &&
    (!Array.isArray(value.networkHosts) ||
      value.networkHosts.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }

  if (
    value.allowedModules !== undefined &&
    (!Array.isArray(value.allowedModules) ||
      value.allowedModules.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }

  if (value.timers !== undefined && typeof value.timers !== "boolean") {
    return false;
  }

  if (
    value.executionProfile !== undefined &&
    value.executionProfile !== "standard" &&
    value.executionProfile !== "isolated-vm" &&
    value.executionProfile !== "sandbox-worker" &&
    value.executionProfile !== "sandbox-iframe" &&
    value.executionProfile !== "sandbox-shadowrealm"
  ) {
    return false;
  }

  if (
    value.storage !== undefined &&
    (!Array.isArray(value.storage) ||
      value.storage.some(
        (entry) => entry !== "localStorage" && entry !== "sessionStorage",
      ))
  ) {
    return false;
  }

  if (!isFiniteNonNegativeNumber(value.maxImports)) {
    return false;
  }

  if (!isFiniteNonNegativeNumber(value.maxComponentInvocations)) {
    return false;
  }

  if (
    value.maxExecutionMs !== undefined &&
    (typeof value.maxExecutionMs !== "number" ||
      !Number.isFinite(value.maxExecutionMs) ||
      value.maxExecutionMs < 1)
  ) {
    return false;
  }

  return true;
}

export function isRuntimeSourceLanguage(
  value: unknown,
): value is RuntimeSourceLanguage {
  return value === "js" || value === "jsx" || value === "ts" || value === "tsx";
}

export function isRuntimeSourceRuntime(
  value: unknown,
): value is RuntimeSourceRuntime {
  return value === "renderify" || value === "preact";
}

export function isRuntimeSourceModule(
  value: unknown,
): value is RuntimeSourceModule {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.code !== "string" || value.code.trim().length === 0) {
    return false;
  }

  if (!isRuntimeSourceLanguage(value.language)) {
    return false;
  }

  if (
    value.exportName !== undefined &&
    (typeof value.exportName !== "string" ||
      value.exportName.trim().length === 0)
  ) {
    return false;
  }

  if (value.runtime !== undefined && !isRuntimeSourceRuntime(value.runtime)) {
    return false;
  }

  return true;
}

export function isRuntimePlanMetadata(
  value: unknown,
): value is RuntimePlanMetadata {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.sourcePrompt !== undefined &&
    typeof value.sourcePrompt !== "string"
  ) {
    return false;
  }

  if (
    value.sourceModel !== undefined &&
    typeof value.sourceModel !== "string"
  ) {
    return false;
  }

  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) ||
      value.tags.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === "sourcePrompt" || key === "sourceModel" || key === "tags") {
      continue;
    }

    if (entry !== undefined && !isJsonValue(entry)) {
      return false;
    }
  }

  return true;
}

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.type !== "string" || value.type.trim().length === 0) {
    return false;
  }

  if (value.payload !== undefined && !isRuntimeStateSnapshot(value.payload)) {
    return false;
  }

  return true;
}

export interface RuntimeEventBinding {
  domEvent: string;
  runtimeEvent: RuntimeEvent;
}

export function parseRuntimeEventBinding(
  propName: string,
  value: JsonValue,
): RuntimeEventBinding | undefined {
  if (!/^on[A-Z]/.test(propName)) {
    return undefined;
  }

  const domEvent = propName.slice(2).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(domEvent)) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return {
      domEvent,
      runtimeEvent: { type: value.trim() },
    };
  }

  if (!isPlainJsonObject(value)) {
    return undefined;
  }

  const eventType = value.type;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return undefined;
  }

  const payload = value.payload;
  if (payload !== undefined && !isRuntimeStateSnapshot(payload)) {
    return undefined;
  }

  return {
    domEvent,
    runtimeEvent: {
      type: eventType.trim(),
      ...(payload ? { payload } : {}),
    },
  };
}

export function isRuntimePlan(value: unknown): value is RuntimePlan {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return false;
  }

  if (
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version <= 0
  ) {
    return false;
  }

  if (!isRuntimeNode(value.root)) {
    return false;
  }

  if (
    value.capabilities !== undefined &&
    !isRuntimeCapabilities(value.capabilities)
  ) {
    return false;
  }

  if (
    value.specVersion !== undefined &&
    (typeof value.specVersion !== "string" ||
      value.specVersion.trim().length === 0)
  ) {
    return false;
  }

  if (
    value.imports !== undefined &&
    (!Array.isArray(value.imports) ||
      value.imports.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }

  if (
    value.moduleManifest !== undefined &&
    !isRuntimeModuleManifest(value.moduleManifest)
  ) {
    return false;
  }

  if (value.state !== undefined && !isRuntimeStateModel(value.state)) {
    return false;
  }

  if (value.source !== undefined && !isRuntimeSourceModule(value.source)) {
    return false;
  }

  if (value.metadata !== undefined && !isRuntimePlanMetadata(value.metadata)) {
    return false;
  }

  return true;
}

/**
 * Normalizes a JSON RuntimePlan candidate without executing model-provided code.
 * Valid plans are returned unchanged; only well-known DOM-like node aliases are
 * converted. Missing fields may receive compatibility defaults, while fields
 * that are present but invalid reject the candidate so callers can repair it.
 */
export function normalizeRuntimePlanCandidate(
  value: unknown,
  options: RuntimePlanNormalizationOptions = {},
): RuntimePlan | undefined {
  if (!isRuntimeNormalizationDataTree(value)) {
    return undefined;
  }
  if (
    isRuntimePlan(value) &&
    isPlainJsonObject(value) &&
    !Object.hasOwn(value, "nodes")
  ) {
    return value;
  }
  if (!isPlainJsonObject(value)) {
    return undefined;
  }

  const rawIdProperty = readOwnDataProperty(value, "id");
  const rawVersionProperty = readOwnDataProperty(value, "version");
  const rawSpecVersionProperty = readOwnDataProperty(value, "specVersion");
  const rawCapabilitiesProperty = readOwnDataProperty(value, "capabilities");
  const rawNodesProperty = readOwnDataProperty(value, "nodes");
  const rawRootProperty = readOwnDataProperty(value, "root");
  if (
    !rawIdProperty ||
    !rawVersionProperty ||
    !rawSpecVersionProperty ||
    !rawCapabilitiesProperty ||
    !rawNodesProperty ||
    !rawRootProperty ||
    (rawNodesProperty.present && rawRootProperty.present)
  ) {
    return undefined;
  }

  const rawId = rawIdProperty.value;
  const rawVersion = rawVersionProperty.value;
  const rawSpecVersion = rawSpecVersionProperty.value;
  const rawCapabilities = rawCapabilitiesProperty.value;
  const rawNodes = rawNodesProperty.value;
  const hasValidId = typeof rawId === "string" && rawId.trim().length > 0;
  const hasValidVersion =
    typeof rawVersion === "number" &&
    Number.isInteger(rawVersion) &&
    rawVersion > 0;
  const hasValidCapabilities = isRuntimeCapabilities(rawCapabilities);
  const hasRuntimeSpecMarker =
    (typeof rawSpecVersion === "string" &&
      rawSpecVersion.trim().startsWith("runtime-plan/")) ||
    (typeof rawVersion === "string" &&
      rawVersion.trim().startsWith("runtime-plan/"));
  const envelopeFieldCount =
    Number(hasValidId) + Number(hasValidVersion) + Number(hasValidCapabilities);
  const hasLegacyNodesEnvelope =
    Array.isArray(rawNodes) &&
    (hasRuntimeSpecMarker || envelopeFieldCount >= 2);
  const hasStrictRuntimeRoot =
    rawRootProperty?.present === true && isRuntimeNode(rawRootProperty.value);
  const hasPlanEnvelopeMarker =
    hasRuntimeSpecMarker ||
    envelopeFieldCount >= 2 ||
    hasLegacyNodesEnvelope ||
    (envelopeFieldCount >= 1 && hasStrictRuntimeRoot);
  if (!hasPlanEnvelopeMarker) {
    return undefined;
  }

  if (
    rawIdProperty.present &&
    (typeof rawId !== "string" || rawId.trim().length === 0)
  ) {
    return undefined;
  }
  const id = rawIdProperty.present
    ? (rawId as string).trim()
    : options.fallbackId?.trim();
  if (!id) {
    return undefined;
  }

  let rootCandidate: unknown;
  if (rawRootProperty.present) {
    if (!isPlainJsonObject(rawRootProperty.value)) {
      return undefined;
    }
    rootCandidate = rawRootProperty.value;
  } else if (Array.isArray(rawNodes)) {
    rootCandidate = {
      type: "container",
      nodes: rawNodes,
    };
  } else {
    return undefined;
  }
  const root = normalizeRuntimeNodeCandidate(rootCandidate);
  if (!root) {
    return undefined;
  }

  const legacySpecVersion =
    typeof rawVersion === "string" &&
    rawVersion.trim().startsWith("runtime-plan/")
      ? rawVersion.trim()
      : undefined;
  if (
    legacySpecVersion &&
    rawSpecVersionProperty.present &&
    typeof rawSpecVersion === "string" &&
    rawSpecVersion.trim() !== legacySpecVersion
  ) {
    return undefined;
  }
  if (
    rawVersionProperty.present &&
    !legacySpecVersion &&
    (typeof rawVersion !== "number" ||
      !Number.isInteger(rawVersion) ||
      rawVersion <= 0)
  ) {
    return undefined;
  }
  if (
    rawSpecVersionProperty.present &&
    (typeof rawSpecVersion !== "string" || rawSpecVersion.trim().length === 0)
  ) {
    return undefined;
  }
  if (
    rawCapabilitiesProperty.present &&
    !isRuntimeCapabilities(rawCapabilities)
  ) {
    return undefined;
  }

  const version =
    typeof rawVersion === "number" && Number.isInteger(rawVersion)
      ? rawVersion
      : 1;
  const specVersion = rawSpecVersionProperty.present
    ? (rawSpecVersion as string).trim()
    : (legacySpecVersion ?? DEFAULT_RUNTIME_PLAN_SPEC_VERSION);
  const capabilities = rawCapabilitiesProperty.present
    ? (rawCapabilities as RuntimeCapabilities)
    : { domWrite: true, allowedModules: [] };

  const candidate: RuntimePlan = {
    specVersion,
    id,
    version,
    root,
    capabilities,
  };

  const rawImportsProperty = readOwnDataProperty(value, "imports");
  if (!rawImportsProperty) {
    return undefined;
  }
  if (rawImportsProperty.present) {
    const rawImports = rawImportsProperty.value;
    if (
      !Array.isArray(rawImports) ||
      !rawImports.every((entry): entry is string => typeof entry === "string")
    ) {
      return undefined;
    }
    candidate.imports = rawImports;
  }

  const rawManifestProperty = readOwnDataProperty(value, "moduleManifest");
  if (!rawManifestProperty) {
    return undefined;
  }
  if (rawManifestProperty.present) {
    if (!isRuntimeModuleManifest(rawManifestProperty.value)) {
      return undefined;
    }
    candidate.moduleManifest = rawManifestProperty.value;
  }

  const rawStateProperty = readOwnDataProperty(value, "state");
  if (!rawStateProperty) {
    return undefined;
  }
  if (rawStateProperty.present) {
    if (!isRuntimeStateModel(rawStateProperty.value)) {
      return undefined;
    }
    candidate.state = rawStateProperty.value;
  }

  const rawSourceProperty = readOwnDataProperty(value, "source");
  if (!rawSourceProperty) {
    return undefined;
  }
  if (rawSourceProperty.present) {
    if (!isRuntimeSourceModule(rawSourceProperty.value)) {
      return undefined;
    }
    candidate.source = rawSourceProperty.value;
  }

  const rawMetadataProperty = readOwnDataProperty(value, "metadata");
  if (!rawMetadataProperty) {
    return undefined;
  }
  if (rawMetadataProperty.present) {
    if (!isRuntimePlanMetadata(rawMetadataProperty.value)) {
      return undefined;
    }
    candidate.metadata = rawMetadataProperty.value;
  }

  return isRuntimePlan(candidate) ? candidate : undefined;
}

export function isRuntimeModuleDescriptor(
  value: unknown,
): value is RuntimeModuleDescriptor {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.resolvedUrl !== "string" ||
    value.resolvedUrl.trim().length === 0
  ) {
    return false;
  }

  if (
    value.integrity !== undefined &&
    (typeof value.integrity !== "string" || value.integrity.trim().length === 0)
  ) {
    return false;
  }

  if (
    value.version !== undefined &&
    (typeof value.version !== "string" || value.version.trim().length === 0)
  ) {
    return false;
  }

  if (
    value.signer !== undefined &&
    (typeof value.signer !== "string" || value.signer.trim().length === 0)
  ) {
    return false;
  }

  return true;
}

export function isRuntimeModuleManifest(
  value: unknown,
): value is RuntimeModuleManifest {
  if (!isRecord(value)) {
    return false;
  }

  for (const [specifier, descriptor] of Object.entries(value)) {
    if (specifier.trim().length === 0) {
      return false;
    }

    if (!isRuntimeModuleDescriptor(descriptor)) {
      return false;
    }
  }

  return true;
}

export function resolveRuntimePlanSpecVersion(specVersion?: string): string {
  if (typeof specVersion === "string" && specVersion.trim().length > 0) {
    return specVersion.trim();
  }

  return DEFAULT_RUNTIME_PLAN_SPEC_VERSION;
}

export interface ParsedNetworkHostPattern {
  hostname: string;
  wildcard: boolean;
  port?: number;
}

export function parseNetworkHostPattern(
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

export function matchesAllowedNetworkUrl(
  url: URL,
  patterns: readonly ParsedNetworkHostPattern[],
): boolean {
  const hostname = url.hostname.toLowerCase();
  const effectivePort = toEffectivePort(url);
  if (!effectivePort) {
    return false;
  }

  for (const pattern of patterns) {
    if (!matchesPatternHostname(hostname, pattern)) {
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

export function isAllowedNetworkUrl(url: URL, allowedHosts: string[]): boolean {
  const parsedPatterns = allowedHosts
    .map((entry) => parseNetworkHostPattern(entry))
    .filter(
      (pattern): pattern is ParsedNetworkHostPattern => pattern !== undefined,
    );
  return matchesAllowedNetworkUrl(url, parsedPatterns);
}

export function isAllowedRequestedNetworkHost(
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

export function walkRuntimeNode(
  node: RuntimeNode,
  visitor: (node: RuntimeNode, depth: number) => void,
  depth = 0,
): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: node, depth },
  ];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const entry = pending.pop();
    if (
      !entry ||
      typeof entry.value !== "object" ||
      entry.value === null ||
      visited.has(entry.value)
    ) {
      continue;
    }

    const shape = inspectRuntimeNodeShape(entry.value);
    if (!shape) {
      continue;
    }

    visited.add(entry.value);
    visitor(shape.node, entry.depth);
    for (let index = shape.children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: shape.children[index], depth: entry.depth + 1 });
    }
  }
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

export function collectComponentModules(root: RuntimeNode): string[] {
  const modules = new Set<string>();

  walkRuntimeNode(root, (node) => {
    if (node.type === "component") {
      modules.add(node.module);
    }
  });

  return [...modules];
}

export function splitPath(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function isSafePath(path: string): boolean {
  const segments = splitPath(path);

  if (segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    if (
      segment === "__proto__" ||
      segment === "prototype" ||
      segment === "constructor"
    ) {
      return false;
    }
  }

  return true;
}

export function getValueByPath(source: unknown, path: string): unknown {
  const segments = splitPath(path);
  if (segments.length === 0 || !isSafePath(path)) {
    return undefined;
  }

  let cursor: unknown = source;

  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }

    if (!Object.hasOwn(cursor, segment)) {
      return undefined;
    }

    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

export function setValueByPath(
  target: RuntimeStateSnapshot,
  path: string,
  value: JsonValue,
): void {
  const segments = splitPath(path);
  if (segments.length === 0 || !isSafePath(path)) {
    return;
  }

  let cursor: Record<string, JsonValue> = target;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    if (isLast) {
      cursor[segment] = value;
      return;
    }

    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, JsonValue>;
  }
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value) as T;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

export function asJsonValue(value: unknown): JsonValue {
  return asJsonValueInternal(value, new Set<object>());
}

function asJsonValueInternal(value: unknown, seen: Set<object>): JsonValue {
  if (value === undefined) {
    return null;
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

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }

    seen.add(value);
    try {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        result.push(
          descriptor && "value" in descriptor
            ? asJsonValueInternal(descriptor.value, seen)
            : null,
        );
      }
      return result;
    } catch {
      return null;
    } finally {
      seen.delete(value);
    }
  }

  if (isPlainJsonObject(value)) {
    if (seen.has(value)) {
      return null;
    }

    seen.add(value);
    const result: JsonObject = {};
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) {
          continue;
        }

        const normalized =
          "value" in descriptor
            ? asJsonValueInternal(descriptor.value, seen)
            : null;
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: normalized,
        });
      }
      return result;
    } catch {
      return null;
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    return null;
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isJsonValueInternal(value: unknown, seen: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !isJsonValueInternal(descriptor.value, seen)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      seen.delete(value);
    }
  }

  if (isPlainJsonObject(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const valid = Object.values(descriptors).every(
        (descriptor) =>
          !descriptor.enumerable ||
          ("value" in descriptor &&
            isJsonValueInternal(descriptor.value, seen)),
      );
      return valid;
    } catch {
      return false;
    } finally {
      seen.delete(value);
    }
  }

  return false;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
