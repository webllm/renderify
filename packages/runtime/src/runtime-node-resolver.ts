import {
  areRuntimeValuesEqual,
  asJsonValue,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_EACH_INDEX_NAME,
  DEFAULT_RUNTIME_EACH_ITEM_NAME,
  getValueByPath,
  isRuntimeControlNode,
  isRuntimeNode,
  isRuntimeNodeShallow,
  isRuntimeTruthy,
  type JsonValue,
  normalizeRuntimeBindPath,
  type RuntimeControlNode,
  type RuntimeDiagnostic,
  type RuntimeEachNode,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeExecutionProfile,
  type RuntimeIfNode,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimeStateSnapshot,
  type RuntimeTemplateScope,
  readRuntimeValueReference,
  walkRuntimeNode,
} from "@renderify/ir";
import {
  executeComponentFactory,
  type RuntimeComponentFactory,
} from "./runtime-component-runtime";
import { isRuntimeModuleMaterializationLimitError } from "./runtime-module-materialization-budget";
import {
  interpolateTemplate,
  resolveJsonValue,
  resolveProps,
  resolveTemplateExpression,
} from "./template";

/**
 * Upper bound on nodes produced by `each` expansion in one execution. Each
 * iteration is charged the size of the loop's child template.
 */
export const RUNTIME_MAX_CONTROL_FLOW_NODES = 10_000;

export interface RuntimeNodeResolutionFrame {
  startedAt: number;
  maxExecutionMs: number;
  maxComponentInvocations: number;
  componentInvocations: number;
  executionProfile: RuntimeExecutionProfile;
  signal?: AbortSignal;
  /** Nodes charged to `each` expansion so far in this execution. */
  controlFlowNodes?: number;
  controlFlowLimitReported?: boolean;
}

export interface RuntimeNodeResolver {
  moduleLoader?: {
    load(specifier: string, signal?: AbortSignal): Promise<unknown>;
  };
  isResolvedSpecifierAllowed?(
    specifier: string,
    diagnostics: RuntimeDiagnostic[],
  ): boolean;
  resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    usage: "import" | "component" | "source-import",
  ): string | undefined;
  withRemainingBudget<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
  resolveNode(
    node: RuntimeNode,
    scope?: RuntimeTemplateScope,
  ): Promise<RuntimeNode>;
  errorToMessage(error: unknown): string;
}

export interface RuntimeNodeResolutionInput {
  node: RuntimeNode;
  moduleManifest: RuntimeModuleManifest | undefined;
  context: RuntimeExecutionContext;
  state: RuntimeStateSnapshot;
  event: RuntimeEvent | undefined;
  diagnostics: RuntimeDiagnostic[];
  frame: RuntimeNodeResolutionFrame;
  resolver: RuntimeNodeResolver;
  /** Loop variables from enclosing `each` nodes. */
  scope?: RuntimeTemplateScope;
}

export async function resolveRuntimeNode(
  input: RuntimeNodeResolutionInput,
): Promise<RuntimeNode> {
  const {
    node,
    moduleManifest,
    context,
    state,
    event,
    diagnostics,
    frame,
    resolver,
    scope,
  } = input;

  if (!isRuntimeNodeShallow(node)) {
    diagnostics.push({
      level: "error",
      code: "RUNTIME_NODE_INVALID",
      message: "Runtime plan contains an invalid node payload",
    });
    return createElementNode("div", { "data-renderify-invalid-node": "true" }, [
      createTextNode("Invalid runtime node"),
    ]);
  }

  if (node.type === "text") {
    return createTextNode(
      interpolateTemplate(node.value, context, state, event, scope),
    );
  }

  if (isRuntimeControlNode(node)) {
    // A control node in a single-node position (the plan root or a component
    // result) renders into a layout-neutral wrapper.
    return createElementNode(
      "div",
      { "data-renderify-fragment": node.type, style: "display:contents" },
      await expandRuntimeControlNode(node, input),
    );
  }

  const resolvedChildren = await resolveRuntimeChildren(
    node.children ?? [],
    input,
  );

  if (node.type === "element") {
    const props = applyRuntimeBindProps(
      node.tag,
      resolveProps(node.props, context, state, event, scope),
      state,
      diagnostics,
    );
    const textareaValue =
      props?.bind !== undefined && node.tag.trim().toLowerCase() === "textarea"
        ? props.value
        : undefined;
    return {
      ...node,
      props,
      children:
        typeof textareaValue === "string"
          ? [createTextNode(textareaValue)]
          : resolvedChildren,
    };
  }

  if (frame.componentInvocations >= frame.maxComponentInvocations) {
    diagnostics.push({
      level: "error",
      code: "RUNTIME_COMPONENT_LIMIT_EXCEEDED",
      message: `Component invocation limit exceeded: ${frame.maxComponentInvocations}`,
    });
    return createElementNode(
      "div",
      { "data-renderify-component-limit": node.module },
      [createTextNode("Component invocation limit exceeded")],
    );
  }

  frame.componentInvocations += 1;

  const resolvedComponentSpecifier = resolver.resolveRuntimeSpecifier(
    node.module,
    moduleManifest,
    diagnostics,
    "component",
  );
  if (!resolvedComponentSpecifier) {
    return createElementNode(
      "div",
      { "data-renderify-component-error": node.module },
      [createTextNode("Missing module manifest entry for component")],
    );
  }

  const moduleLoader = resolver.moduleLoader;
  if (!moduleLoader) {
    diagnostics.push({
      level: "warning",
      code: "RUNTIME_COMPONENT_SKIPPED",
      message: `Component ${resolvedComponentSpecifier} skipped because module loader is missing`,
    });
    return createElementNode(
      "div",
      { "data-renderify-missing-module": node.module },
      resolvedChildren,
    );
  }

  if (
    resolver.isResolvedSpecifierAllowed &&
    !resolver.isResolvedSpecifierAllowed(
      resolvedComponentSpecifier,
      diagnostics,
    )
  ) {
    return createElementNode(
      "div",
      { "data-renderify-component-error": node.module },
      [createTextNode("Component module is blocked by runtime network policy")],
    );
  }

  try {
    const loaded = await resolver.withRemainingBudget(
      (signal) => moduleLoader.load(resolvedComponentSpecifier, signal),
      `Component module timed out: ${resolvedComponentSpecifier}`,
    );

    const exportName = node.exportName ?? "default";
    const target = selectExportFromNamespace(loaded, exportName);

    if (typeof target !== "function") {
      diagnostics.push({
        level: "error",
        code: "RUNTIME_COMPONENT_INVALID",
        message: `Export ${exportName} from ${resolvedComponentSpecifier} is not callable`,
      });
      return createElementNode(
        "div",
        { "data-renderify-component-error": `${node.module}:${exportName}` },
        [createTextNode("Component export is not callable")],
      );
    }

    const runtimeContext: RuntimeExecutionContext = {
      ...context,
      variables: {
        ...(context.variables ?? {}),
        state,
        event: event ? asJsonValue(event) : null,
      },
    };

    const produced = await executeComponentFactory({
      componentFactory: target as RuntimeComponentFactory,
      props: resolveProps(node.props, context, state, event, scope) ?? {},
      context: runtimeContext,
      children: resolvedChildren,
      timeoutMessage: `Component execution timed out: ${node.module}`,
      withRemainingBudget: resolver.withRemainingBudget,
    });

    if (typeof produced === "string") {
      return createTextNode(
        interpolateTemplate(produced, context, state, event, scope),
      );
    }

    if (isRuntimeNode(produced)) {
      return resolver.resolveNode(produced, scope);
    }

    diagnostics.push({
      level: "error",
      code: "RUNTIME_COMPONENT_OUTPUT_INVALID",
      message: `Component ${resolvedComponentSpecifier} produced unsupported output`,
    });
    return createElementNode(
      "div",
      { "data-renderify-component-error": node.module },
      [createTextNode("Unsupported component output")],
    );
  } catch (error) {
    if (isRuntimeModuleMaterializationLimitError(error)) {
      return createElementNode(
        "div",
        { "data-renderify-component-error": node.module },
        [createTextNode("Component module import limit exceeded")],
      );
    }
    diagnostics.push({
      level: "error",
      code: "RUNTIME_COMPONENT_EXEC_FAILED",
      message: `${resolvedComponentSpecifier}: ${resolver.errorToMessage(error)}`,
    });
    return createElementNode(
      "div",
      { "data-renderify-component-error": node.module },
      [createTextNode("Component execution failed")],
    );
  }
}

async function resolveRuntimeChildren(
  nodes: RuntimeNode[],
  input: RuntimeNodeResolutionInput,
): Promise<RuntimeNode[]> {
  const resolved: RuntimeNode[] = [];
  for (const child of nodes) {
    if (isRuntimeControlNode(child)) {
      resolved.push(...(await expandRuntimeControlNode(child, input)));
      continue;
    }
    resolved.push(await input.resolver.resolveNode(child, input.scope));
  }
  return resolved;
}

/** Expands an `each` or `if` node into the nodes it renders, in place. */
async function expandRuntimeControlNode(
  node: RuntimeControlNode,
  input: RuntimeNodeResolutionInput,
): Promise<RuntimeNode[]> {
  return node.type === "if"
    ? expandRuntimeIfNode(node, input)
    : expandRuntimeEachNode(node, input);
}

function resolveRuntimeReference(
  reference: string,
  input: RuntimeNodeResolutionInput,
): unknown {
  const path = readRuntimeValueReference(reference);
  return path === undefined
    ? undefined
    : resolveTemplateExpression(
        path,
        input.context,
        input.state,
        input.event,
        input.scope,
      );
}

async function expandRuntimeIfNode(
  node: RuntimeIfNode,
  input: RuntimeNodeResolutionInput,
): Promise<RuntimeNode[]> {
  const subject = resolveRuntimeReference(node.when, input);
  let matched =
    node.equals === undefined
      ? isRuntimeTruthy(subject)
      : areRuntimeValuesEqual(
          subject,
          typeof node.equals === "string"
            ? resolveJsonValue(
                node.equals,
                input.context,
                input.state,
                input.event,
                input.scope,
              )
            : node.equals,
        );
  if (node.not === true) {
    matched = !matched;
  }
  return matched ? resolveRuntimeChildren(node.children ?? [], input) : [];
}

const CONTROL_TEMPLATE_SIZES = new WeakMap<RuntimeEachNode, number>();

function getEachTemplateSize(node: RuntimeEachNode): number {
  const cached = CONTROL_TEMPLATE_SIZES.get(node);
  if (cached !== undefined) {
    return cached;
  }
  let size = 0;
  for (const child of node.children ?? []) {
    walkRuntimeNode(child, () => {
      size += 1;
    });
  }
  const charged = Math.max(1, size);
  CONTROL_TEMPLATE_SIZES.set(node, charged);
  return charged;
}

async function expandRuntimeEachNode(
  node: RuntimeEachNode,
  input: RuntimeNodeResolutionInput,
): Promise<RuntimeNode[]> {
  const items = resolveRuntimeReference(node.items, input);
  if (items === undefined || items === null) {
    return [];
  }
  if (!Array.isArray(items)) {
    input.diagnostics.push({
      level: "warning",
      code: "RUNTIME_EACH_ITEMS_INVALID",
      message: `each.items "${node.items}" did not resolve to an array`,
    });
    return [];
  }

  const itemName = node.as ?? DEFAULT_RUNTIME_EACH_ITEM_NAME;
  const indexName = node.index ?? DEFAULT_RUNTIME_EACH_INDEX_NAME;
  const templateSize = getEachTemplateSize(node);
  const { frame } = input;
  const expanded: RuntimeNode[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const charged = (frame.controlFlowNodes ?? 0) + templateSize;
    if (charged > RUNTIME_MAX_CONTROL_FLOW_NODES) {
      if (!frame.controlFlowLimitReported) {
        frame.controlFlowLimitReported = true;
        input.diagnostics.push({
          level: "warning",
          code: "RUNTIME_EACH_LIMIT_EXCEEDED",
          message: `each rendering stopped after ${RUNTIME_MAX_CONTROL_FLOW_NODES} nodes; showing ${index} of ${items.length} items from "${node.items}"`,
        });
      }
      break;
    }
    frame.controlFlowNodes = charged;

    const item = asJsonValue(items[index]);
    const iteration = await resolveRuntimeChildren(node.children ?? [], {
      ...input,
      scope: { ...input.scope, [itemName]: item, [indexName]: index },
    });
    applyRuntimeEachKeys(iteration, node.key, item);
    expanded.push(...iteration);
  }

  return expanded;
}

/**
 * Gives each element rendered by one loop iteration a stable `key` derived
 * from the item, so reordering or removing items reuses the right DOM nodes.
 */
function applyRuntimeEachKeys(
  nodes: RuntimeNode[],
  keyPath: string | undefined,
  item: JsonValue,
): void {
  if (keyPath === undefined) {
    return;
  }
  const keyValue = getValueByPath(item, keyPath);
  if (
    typeof keyValue !== "string" &&
    !(typeof keyValue === "number" && Number.isFinite(keyValue))
  ) {
    return;
  }
  const elements = nodes.filter((node) => node.type === "element");
  for (let position = 0; position < elements.length; position += 1) {
    const element = elements[position];
    if (element.props?.key !== undefined) {
      continue;
    }
    element.props = {
      ...(element.props ?? {}),
      key:
        elements.length > 1
          ? `${String(keyValue)}:${position}`
          : String(keyValue),
    };
  }
}

const RUNTIME_BINDABLE_TAGS = new Set(["input", "textarea", "select"]);
const RUNTIME_UNBINDABLE_INPUT_TYPES = new Set([
  "password",
  "file",
  "button",
  "submit",
  "reset",
  "image",
]);

/**
 * Turns a `bind` prop into the control's current value from state. The
 * normalized path stays on `bind` so the renderer can wire the control.
 * Password and file inputs are never bound, so their contents cannot flow
 * into plan state, events, or a host's model context.
 */
function applyRuntimeBindProps(
  tag: string,
  props: Record<string, JsonValue> | undefined,
  state: RuntimeStateSnapshot,
  diagnostics: RuntimeDiagnostic[],
): Record<string, JsonValue> | undefined {
  if (!props || !Object.hasOwn(props, "bind")) {
    return props;
  }
  const { bind, ...rest } = props;
  const normalizedTag = tag.trim().toLowerCase();
  const inputType =
    typeof rest.type === "string" ? rest.type.trim().toLowerCase() : "text";
  const path = normalizeRuntimeBindPath(bind);
  if (
    !path ||
    !RUNTIME_BINDABLE_TAGS.has(normalizedTag) ||
    (normalizedTag === "input" && RUNTIME_UNBINDABLE_INPUT_TYPES.has(inputType))
  ) {
    diagnostics.push({
      level: "warning",
      code: "RUNTIME_BIND_INVALID",
      message: `bind "${String(bind)}" was ignored on <${normalizedTag}${
        normalizedTag === "input" ? ` type="${inputType}"` : ""
      }>; bind a state path on an input, textarea, or select`,
    });
    return rest;
  }

  const current = getValueByPath(state, path);
  const next: Record<string, JsonValue> = { ...rest, bind: path };
  if (normalizedTag === "input" && inputType === "checkbox") {
    next.checked = isRuntimeTruthy(current);
  } else if (normalizedTag === "input" && inputType === "radio") {
    next.checked = areRuntimeValuesEqual(current, rest.value ?? "on");
  } else {
    next.value =
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
        ? String(current)
        : "";
  }
  return next;
}

export function selectExportFromNamespace(
  moduleNamespace: unknown,
  exportName: string,
): unknown {
  if (typeof moduleNamespace !== "object" || moduleNamespace === null) {
    return undefined;
  }

  const record = moduleNamespace as Record<string, unknown>;
  return record[exportName];
}
