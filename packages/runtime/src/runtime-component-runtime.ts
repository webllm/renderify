import type {
  JsonValue,
  RuntimeDiagnostic,
  RuntimeExecutionContext,
  RuntimeNode,
  RuntimeRenderArtifact,
} from "@renderify/ir";
import { getPreactSpecifier, hasPreactFactory } from "./runtime-environment";

type PreactLikeModule = {
  h(type: unknown, props: unknown, ...children: unknown[]): unknown;
};

type PreactLikeClassComponent = new (
  ...args: unknown[]
) => {
  render(...args: unknown[]): unknown;
};

const PREACT_FUNCTION_COMPONENT_WRAPPERS = new WeakMap<
  (props: Record<string, JsonValue>) => unknown,
  (props: Record<string, JsonValue>) => unknown
>();
const PREACT_CLASS_COMPONENT_WRAPPERS = new WeakMap<
  PreactLikeClassComponent,
  PreactLikeClassComponent
>();

export type RuntimeComponentFactory = (
  props: Record<string, JsonValue>,
  context: RuntimeExecutionContext,
  children: RuntimeNode[],
) => Promise<RuntimeNode | string> | RuntimeNode | string;

export async function createPreactRenderArtifact(input: {
  sourceExport: unknown;
  runtimeInput: Record<string, JsonValue>;
  diagnostics: RuntimeDiagnostic[];
  wrapWithEmotionCache?: boolean;
  emotionCacheBoundary?: {
    provider: unknown;
    value: unknown;
  };
}): Promise<RuntimeRenderArtifact | undefined> {
  const preact = await loadPreactModule();
  if (!preact) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_UNAVAILABLE",
      message:
        "source.runtime=preact requested but preact runtime is unavailable",
    });
    return undefined;
  }

  if (isPreactLikeVNode(input.sourceExport)) {
    return {
      mode: "preact-vnode",
      payload: input.sourceExport,
    };
  }

  if (isPlainObjectPreactOutput(input.sourceExport)) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_EXPORT_INVALID",
      message:
        'source.runtime=preact requires JSX/h() output instead of a plain object; use source.runtime="renderify" for RuntimeNode output',
    });
    return undefined;
  }

  if (typeof input.sourceExport !== "function") {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_EXPORT_INVALID",
      message: "source.runtime=preact requires a component export function",
    });
    return undefined;
  }

  try {
    const component = isPreactClassComponent(input.sourceExport)
      ? wrapPreactClassComponent(input.sourceExport as PreactLikeClassComponent)
      : wrapPreactFunctionComponent(
          input.sourceExport as (props: Record<string, JsonValue>) => unknown,
        );
    let vnode = preact.h(component, input.runtimeInput);
    if (input.wrapWithEmotionCache) {
      if (!input.emotionCacheBoundary) {
        input.diagnostics.push({
          level: "error",
          code: "RUNTIME_EMOTION_CACHE_UNAVAILABLE",
          message:
            "Material UI server rendering requires an Emotion CacheProvider, but the local Emotion runtime is unavailable",
        });
        return undefined;
      }
      vnode = preact.h(
        input.emotionCacheBoundary.provider,
        { value: input.emotionCacheBoundary.value },
        vnode,
      );
    }

    return {
      mode: "preact-vnode",
      payload: vnode,
    };
  } catch (error) {
    input.diagnostics.push({
      level: "error",
      code: "RUNTIME_PREACT_VNODE_FAILED",
      message: errorToMessage(error),
    });
    return undefined;
  }
}

export async function executeComponentFactory(input: {
  componentFactory: RuntimeComponentFactory;
  props: Record<string, JsonValue>;
  context: RuntimeExecutionContext;
  children: RuntimeNode[];
  timeoutMessage: string;
  withRemainingBudget<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    timeoutMessage: string,
  ): Promise<T>;
}): Promise<RuntimeNode | string> {
  return input.withRemainingBudget(
    async () =>
      input.componentFactory(input.props, input.context, input.children),
    input.timeoutMessage,
  );
}

function isPreactLikeVNode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    "type" in record && "props" in record && "__v" in record && "__k" in record
  );
}

function isPlainObjectPreactOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return "type" in record && "props" in record && !isPreactLikeVNode(record);
}

function isPreactClassComponent(value: unknown): boolean {
  if (typeof value !== "function") {
    return false;
  }

  const prototype = (value as { prototype?: { render?: unknown } }).prototype;
  return typeof prototype?.render === "function";
}

function wrapPreactClassComponent(
  sourceComponent: PreactLikeClassComponent,
): PreactLikeClassComponent {
  const cached = PREACT_CLASS_COMPONENT_WRAPPERS.get(sourceComponent);
  if (cached) {
    return cached;
  }

  const wrapped = class RenderifyPreactSourceClassWrapper extends sourceComponent {
    render(...args: unknown[]): unknown {
      const output = super.render(...args);
      if (isPlainObjectPreactOutput(output)) {
        throw new Error(
          'source.runtime=preact component returned a plain object; return JSX/h() output or use source.runtime="renderify"',
        );
      }
      return output;
    }
  };

  PREACT_CLASS_COMPONENT_WRAPPERS.set(sourceComponent, wrapped);
  return wrapped;
}

function wrapPreactFunctionComponent(
  sourceComponent: (props: Record<string, JsonValue>) => unknown,
): (props: Record<string, JsonValue>) => unknown {
  const cached = PREACT_FUNCTION_COMPONENT_WRAPPERS.get(sourceComponent);
  if (cached) {
    return cached;
  }

  const wrapped = function RenderifyPreactSourceWrapper(
    props: Record<string, JsonValue>,
  ): unknown {
    const output = sourceComponent(props);
    if (isPlainObjectPreactOutput(output)) {
      throw new Error(
        'source.runtime=preact component returned a plain object; return JSX/h() output or use source.runtime="renderify"',
      );
    }
    return output;
  };

  PREACT_FUNCTION_COMPONENT_WRAPPERS.set(sourceComponent, wrapped);
  return wrapped;
}

async function loadPreactModule(): Promise<PreactLikeModule | undefined> {
  try {
    const maybePreact = (await import(getPreactSpecifier())) as unknown;
    if (!hasPreactFactory(maybePreact)) {
      return undefined;
    }

    return maybePreact;
  } catch {
    return undefined;
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
