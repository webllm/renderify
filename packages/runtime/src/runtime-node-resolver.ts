import {
  asJsonValue,
  createElementNode,
  createTextNode,
  isRuntimeNode,
  type RuntimeDiagnostic,
  type RuntimeEvent,
  type RuntimeExecutionContext,
  type RuntimeExecutionProfile,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  executeComponentFactory,
  type RuntimeComponentFactory,
} from "./runtime-component-runtime";
import { interpolateTemplate, resolveProps } from "./template";

export interface RuntimeNodeResolutionFrame {
  startedAt: number;
  maxExecutionMs: number;
  maxComponentInvocations: number;
  componentInvocations: number;
  executionProfile: RuntimeExecutionProfile;
  signal?: AbortSignal;
}

export interface RuntimeNodeResolver {
  moduleLoader?: {
    load(specifier: string): Promise<unknown>;
  };
  allowIsolationFallback: boolean;
  resolveRuntimeSpecifier(
    specifier: string,
    moduleManifest: RuntimeModuleManifest | undefined,
    diagnostics: RuntimeDiagnostic[],
    usage: "import" | "component" | "source-import",
  ): string | undefined;
  withRemainingBudget<T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
  resolveNode(node: RuntimeNode): Promise<RuntimeNode>;
  errorToMessage(error: unknown): string;
}

export async function resolveRuntimeNode(input: {
  node: RuntimeNode;
  moduleManifest: RuntimeModuleManifest | undefined;
  context: RuntimeExecutionContext;
  state: RuntimeStateSnapshot;
  event: RuntimeEvent | undefined;
  diagnostics: RuntimeDiagnostic[];
  frame: RuntimeNodeResolutionFrame;
  resolver: RuntimeNodeResolver;
}): Promise<RuntimeNode> {
  const {
    node,
    moduleManifest,
    context,
    state,
    event,
    diagnostics,
    frame,
    resolver,
  } = input;

  if (!isRuntimeNode(node)) {
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
      interpolateTemplate(node.value, context, state, event),
    );
  }

  const resolvedChildren = await resolveChildren(
    node.children ?? [],
    resolver.resolveNode,
  );

  if (node.type === "element") {
    return {
      ...node,
      props: resolveProps(node.props, context, state, event),
      children: resolvedChildren,
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

  if (!resolver.moduleLoader) {
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

  try {
    const loaded = await resolver.withRemainingBudget(
      () => resolver.moduleLoader!.load(resolvedComponentSpecifier),
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
      props: resolveProps(node.props, context, state, event) ?? {},
      context: runtimeContext,
      children: resolvedChildren,
      executionProfile: frame.executionProfile,
      maxExecutionMs: frame.maxExecutionMs,
      startedAt: frame.startedAt,
      timeoutMessage: `Component execution timed out: ${node.module}`,
      allowIsolationFallback: resolver.allowIsolationFallback,
      diagnostics,
      withRemainingBudget: resolver.withRemainingBudget,
    });

    if (typeof produced === "string") {
      return createTextNode(
        interpolateTemplate(produced, context, state, event),
      );
    }

    if (isRuntimeNode(produced)) {
      return resolver.resolveNode(produced);
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

async function resolveChildren(
  nodes: RuntimeNode[],
  resolveNode: (node: RuntimeNode) => Promise<RuntimeNode>,
): Promise<RuntimeNode[]> {
  const resolved: RuntimeNode[] = [];
  for (const child of nodes) {
    resolved.push(await resolveNode(child));
  }
  return resolved;
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
