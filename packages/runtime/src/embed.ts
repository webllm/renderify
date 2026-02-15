import type { RuntimePlan } from "@renderify/ir";
import { DefaultSecurityChecker } from "@renderify/security";
import { JspmModuleLoader } from "./jspm-module-loader";
import { DefaultRuntimeManager } from "./manager";
import { autoPinRuntimePlanModuleManifest } from "./module-manifest-autopin";
import {
  type RuntimeEmbedRenderOptions,
  type RuntimeEmbedRenderResult,
  RuntimeSecurityViolationError,
} from "./runtime-manager.types";
import { DefaultUIRenderer, type RenderTarget } from "./ui-renderer";

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

function isInteractiveRenderTargetValue(
  target: RenderTarget,
): target is { element: string | HTMLElement } {
  return (
    typeof target === "object" &&
    target !== null &&
    "element" in target &&
    (typeof target.element === "string" ||
      (typeof HTMLElement !== "undefined" &&
        target.element instanceof HTMLElement))
  );
}
