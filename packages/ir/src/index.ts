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

  const type = readOwnDataProperty(value, "type");
  if (!type?.present || typeof type.value !== "string") {
    return undefined;
  }

  if (type.value === "text") {
    const text = readOwnDataProperty(value, "value");
    return text?.present && typeof text.value === "string"
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

  const children: unknown[] = [];
  try {
    for (let index = 0; index < property.value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        property.value,
        String(index),
      );
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
