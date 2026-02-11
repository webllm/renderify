export type JsonPrimitive = string | number | boolean | null;

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

export type RuntimeExecutionProfile = "standard" | "isolated-vm";

export type RuntimeSourceLanguage = "js" | "jsx" | "ts" | "tsx";

export interface RuntimeSourceModule {
  code: string;
  language: RuntimeSourceLanguage;
  exportName?: string;
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
  capabilities: RuntimeCapabilities;
  state?: RuntimeStateModel;
  imports?: string[];
  moduleManifest?: RuntimeModuleManifest;
  source?: RuntimeSourceModule;
  metadata?: RuntimePlanMetadata;
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

export interface RuntimeExecutionResult {
  planId: string;
  root: RuntimeNode;
  diagnostics: RuntimeDiagnostic[];
  state?: RuntimeStateSnapshot;
  handledEvent?: RuntimeEvent;
  appliedActions?: RuntimeAction[];
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
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimeNode>;

  if (candidate.type === "text") {
    return typeof (candidate as RuntimeTextNode).value === "string";
  }

  if (candidate.type === "element") {
    return typeof (candidate as RuntimeElementNode).tag === "string";
  }

  if (candidate.type === "component") {
    return typeof (candidate as RuntimeComponentNode).module === "string";
  }

  return false;
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
    value.executionProfile !== "isolated-vm"
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

  if (!isRuntimeCapabilities(value.capabilities)) {
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

export function walkRuntimeNode(
  node: RuntimeNode,
  visitor: (node: RuntimeNode, depth: number) => void,
  depth = 0,
): void {
  visitor(node, depth);

  const children = node.type === "text" ? undefined : node.children;
  if (!children || children.length === 0) {
    return;
  }

  for (const child of children) {
    walkRuntimeNode(child, visitor, depth + 1);
  }
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
  if (segments.length === 0) {
    return undefined;
  }

  let cursor: unknown = source;

  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) {
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
  if (segments.length === 0) {
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
    return value.map((item) => asJsonValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = asJsonValue(item);
    }
    return result;
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
    const valid = value.every((entry) => isJsonValueInternal(entry, seen));
    seen.delete(value);
    return valid;
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    const valid = Object.values(value).every((entry) =>
      isJsonValueInternal(entry, seen),
    );
    seen.delete(value);
    return valid;
  }

  return false;
}
