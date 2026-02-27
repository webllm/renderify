import type {
  RuntimeEvent,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import { DefaultSecurityChecker } from "@renderify/security";
import { JspmModuleLoader } from "./jspm-module-loader";
import { DefaultRuntimeManager } from "./manager";
import { autoPinRuntimePlanModuleManifest } from "./module-manifest-autopin";
import {
  type RuntimeEmbedRenderOptions,
  type RuntimeEmbedRenderResult,
  type RuntimeManager,
  RuntimeSecurityViolationError,
} from "./runtime-manager.types";
import {
  DefaultUIRenderer,
  type RenderTarget,
  type RuntimeEventDispatchRequest,
} from "./ui-renderer";

const EMBED_TARGET_RENDER_LOCKS = new WeakMap<HTMLElement, Promise<void>>();

export async function renderPlanInBrowser(
  plan: RuntimePlan,
  options: RuntimeEmbedRenderOptions = {},
): Promise<RuntimeEmbedRenderResult> {
  const renderOperation = async (): Promise<RuntimeEmbedRenderResult> => {
    const ui = options.ui ?? new DefaultUIRenderer();
    const moduleLoader =
      options.autoPinModuleLoader ??
      options.runtimeOptions?.moduleLoader ??
      new JspmModuleLoader();
    const security = options.security ?? new DefaultSecurityChecker();
    security.initialize(options.securityInitialization);
    const policy = security.getPolicy();
    const runtime =
      options.runtime ??
      new DefaultRuntimeManager({
        moduleLoader,
        ...(options.runtimeOptions ?? {}),
        allowArbitraryNetwork: policy.allowArbitraryNetwork,
        allowedNetworkHosts: policy.allowedNetworkHosts,
      });

    const shouldInitializeRuntime =
      options.autoInitializeRuntime !== false || options.runtime === undefined;
    const shouldTerminateRuntime =
      options.autoTerminateRuntime !== false && options.runtime === undefined;

    if (shouldInitializeRuntime) {
      await runtime.initialize();
    }

    try {
      const planForExecution = await autoPinRuntimePlanModuleManifest(plan, {
        enabled: options.autoPinLatestModuleManifest !== false,
        moduleLoader,
        fetchTimeoutMs: options.autoPinFetchTimeoutMs,
        signal: options.signal,
      });

      const securityResult = await security.checkPlan(planForExecution);
      if (!securityResult.safe) {
        throw new RuntimeSecurityViolationError(securityResult);
      }

      const execution = await runtime.execute({
        plan: planForExecution,
        context: options.context,
        signal: options.signal,
      });
      const html = await ui.render(execution, options.target);

      return {
        html,
        execution,
        security: securityResult,
        runtime,
      };
    } finally {
      if (shouldTerminateRuntime) {
        await runtime.terminate();
      }
    }
  };

  const shouldSerialize = options.serializeTargetRenders !== false;
  const targetElement = shouldSerialize
    ? resolveEmbedRenderTargetElement(options.target)
    : undefined;

  if (targetElement) {
    return withEmbedTargetRenderLock(targetElement, renderOperation);
  }

  return renderOperation();
}

export interface RuntimeInteractiveSession {
  readonly plan: RuntimePlan;
  readonly runtime: RuntimeManager;
  readonly security: RuntimeEmbedRenderResult["security"];
  render(event?: RuntimeEvent): Promise<RuntimeEmbedRenderResult>;
  dispatch(event: RuntimeEvent): Promise<RuntimeEmbedRenderResult>;
  getState(): RuntimeStateSnapshot | undefined;
  setState(snapshot: RuntimeStateSnapshot): Promise<RuntimeEmbedRenderResult>;
  clearState(): Promise<RuntimeEmbedRenderResult>;
  getLastResult(): RuntimeEmbedRenderResult;
  terminate(): Promise<void>;
}

export async function createInteractiveSession(
  plan: RuntimePlan,
  options: RuntimeEmbedRenderOptions = {},
): Promise<RuntimeInteractiveSession> {
  const ui = options.ui ?? new DefaultUIRenderer();
  const moduleLoader =
    options.autoPinModuleLoader ??
    options.runtimeOptions?.moduleLoader ??
    new JspmModuleLoader();
  const security = options.security ?? new DefaultSecurityChecker();
  security.initialize(options.securityInitialization);
  const policy = security.getPolicy();
  const runtime =
    options.runtime ??
    new DefaultRuntimeManager({
      moduleLoader,
      ...(options.runtimeOptions ?? {}),
      allowArbitraryNetwork: policy.allowArbitraryNetwork,
      allowedNetworkHosts: policy.allowedNetworkHosts,
    });

  const shouldInitializeRuntime =
    options.autoInitializeRuntime !== false || options.runtime === undefined;
  const shouldTerminateRuntime =
    options.autoTerminateRuntime !== false && options.runtime === undefined;

  if (shouldInitializeRuntime) {
    await runtime.initialize();
  }

  let terminated = false;
  let lastResult: RuntimeEmbedRenderResult | undefined;
  let queuedRender = Promise.resolve();

  const enqueueRender = async <T>(task: () => Promise<T>): Promise<T> => {
    const run = queuedRender.then(task, task);
    queuedRender = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  try {
    const planForExecution = await autoPinRuntimePlanModuleManifest(plan, {
      enabled: options.autoPinLatestModuleManifest !== false,
      moduleLoader,
      fetchTimeoutMs: options.autoPinFetchTimeoutMs,
      signal: options.signal,
    });

    const securityResult = await security.checkPlan(planForExecution);
    if (!securityResult.safe) {
      throw new RuntimeSecurityViolationError(securityResult);
    }

    const executeAndRender = async (
      event?: RuntimeEvent,
    ): Promise<RuntimeEmbedRenderResult> => {
      if (terminated) {
        throw new Error("Interactive session has been terminated");
      }

      const renderOperation = async (): Promise<RuntimeEmbedRenderResult> => {
        const execution = await runtime.execute({
          plan: planForExecution,
          context: options.context,
          event,
          signal: options.signal,
        });
        const html = await ui.render(
          execution,
          toInteractiveSessionTarget(options.target, async (request) => {
            await enqueueRender(() => executeAndRender(request.event));
          }),
        );

        return {
          html,
          execution,
          security: securityResult,
          runtime,
        };
      };

      const shouldSerialize = options.serializeTargetRenders !== false;
      const targetElement = shouldSerialize
        ? resolveEmbedRenderTargetElement(options.target)
        : undefined;
      const result = targetElement
        ? await withEmbedTargetRenderLock(targetElement, renderOperation)
        : await renderOperation();
      lastResult = result;
      return result;
    };

    await enqueueRender(() => executeAndRender());

    return {
      plan: planForExecution,
      runtime,
      security: securityResult,
      render: (event) => enqueueRender(() => executeAndRender(event)),
      dispatch: (event) => enqueueRender(() => executeAndRender(event)),
      getState: () => runtime.getPlanState(planForExecution.id),
      setState: (snapshot) =>
        enqueueRender(async () => {
          runtime.setPlanState(planForExecution.id, snapshot);
          return executeAndRender();
        }),
      clearState: () =>
        enqueueRender(async () => {
          runtime.clearPlanState(planForExecution.id);
          return executeAndRender();
        }),
      getLastResult: () => {
        if (!lastResult) {
          throw new Error("Interactive session has not rendered yet");
        }
        return lastResult;
      },
      terminate: async () => {
        if (terminated) {
          return;
        }
        terminated = true;
        if (shouldTerminateRuntime) {
          await runtime.terminate();
        }
      },
    };
  } catch (error) {
    terminated = true;
    if (shouldTerminateRuntime) {
      await runtime.terminate();
    }
    throw error;
  }
}

async function withEmbedTargetRenderLock<T>(
  target: HTMLElement,
  operation: () => Promise<T>,
): Promise<T> {
  const previousLock =
    EMBED_TARGET_RENDER_LOCKS.get(target) ?? Promise.resolve();

  let releaseCurrentLock: (() => void) | undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  const queuedLock = previousLock
    .catch(() => undefined)
    .then(() => currentLock);
  EMBED_TARGET_RENDER_LOCKS.set(target, queuedLock);

  await previousLock.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrentLock?.();
    if (EMBED_TARGET_RENDER_LOCKS.get(target) === queuedLock) {
      EMBED_TARGET_RENDER_LOCKS.delete(target);
    }
  }
}

function resolveEmbedRenderTargetElement(
  target: RenderTarget | undefined,
): HTMLElement | undefined {
  if (typeof document === "undefined" || !target) {
    return undefined;
  }

  if (typeof target === "string") {
    return document.querySelector<HTMLElement>(target) ?? undefined;
  }

  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return target;
  }

  if (isInteractiveRenderTargetValue(target)) {
    if (typeof target.element === "string") {
      return document.querySelector<HTMLElement>(target.element) ?? undefined;
    }

    return target.element;
  }

  return undefined;
}

function isInteractiveRenderTargetValue(target: RenderTarget): target is {
  element: string | HTMLElement;
  onRuntimeEvent?: (
    request: RuntimeEventDispatchRequest,
  ) => void | Promise<void>;
} {
  return (
    typeof target === "object" &&
    target !== null &&
    "element" in target &&
    (typeof target.element === "string" ||
      (typeof HTMLElement !== "undefined" &&
        target.element instanceof HTMLElement))
  );
}

function toInteractiveSessionTarget(
  target: RenderTarget | undefined,
  dispatchEvent: (request: RuntimeEventDispatchRequest) => Promise<void>,
): RenderTarget | undefined {
  if (!target) {
    return target;
  }

  if (isInteractiveRenderTargetValue(target)) {
    return {
      element: target.element,
      onRuntimeEvent: async (request) => {
        await dispatchEvent(request);
        if (target.onRuntimeEvent) {
          await target.onRuntimeEvent(request);
        }
      },
    };
  }

  return {
    element: target,
    onRuntimeEvent: dispatchEvent,
  };
}
