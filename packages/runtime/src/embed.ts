import type {
  RuntimeEvent,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  DefaultSecurityChecker,
  type RuntimeSecurityProfile,
  type SecurityInitializationOptions,
} from "@renderify/security";
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
const TRUSTED_EMBED_PROFILE: RuntimeSecurityProfile = "trusted";

export async function renderTrustedPlanInBrowser(
  plan: RuntimePlan,
  options: RuntimeEmbedRenderOptions = {},
): Promise<RuntimeEmbedRenderResult> {
  return renderPlanInBrowser(plan, withTrustedEmbedDefaults(options));
}

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
    const security = resolveEmbedSecurity(options);
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
      const { planForExecution, securityResult } =
        await preparePlanForExecution(plan, options, security, moduleLoader);

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

export async function createTrustedInteractiveSession(
  plan: RuntimePlan,
  options: RuntimeEmbedRenderOptions = {},
): Promise<RuntimeInteractiveSession> {
  return createInteractiveSession(plan, withTrustedEmbedDefaults(options));
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
  const security = resolveEmbedSecurity(options);
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
    const { planForExecution, securityResult } = await preparePlanForExecution(
      plan,
      options,
      security,
      moduleLoader,
    );

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

function resolveEmbedSecurity(
  options: RuntimeEmbedRenderOptions,
): NonNullable<RuntimeEmbedRenderOptions["security"]> {
  const security = options.security ?? new DefaultSecurityChecker();

  if (
    options.security === undefined ||
    options.securityInitialization !== undefined
  ) {
    security.initialize(options.securityInitialization);
  }

  return security;
}

function withTrustedEmbedDefaults(
  options: RuntimeEmbedRenderOptions,
): RuntimeEmbedRenderOptions {
  const runtimeOptions =
    options.runtimeOptions?.remoteFallbackCdnBases === undefined
      ? {
          ...(options.runtimeOptions ?? {}),
          remoteFallbackCdnBases: [],
        }
      : options.runtimeOptions;
  const shouldApplyTrustedInitialization =
    options.security === undefined ||
    options.securityInitialization !== undefined;

  return {
    ...options,
    runtimeOptions,
    securityInitialization: shouldApplyTrustedInitialization
      ? mergeSecurityInitializationProfile(
          options.securityInitialization,
          TRUSTED_EMBED_PROFILE,
        )
      : options.securityInitialization,
  };
}

async function preparePlanForExecution(
  plan: RuntimePlan,
  options: RuntimeEmbedRenderOptions,
  security: NonNullable<RuntimeEmbedRenderOptions["security"]>,
  moduleLoader: NonNullable<RuntimeEmbedRenderOptions["autoPinModuleLoader"]>,
): Promise<{
  planForExecution: RuntimePlan;
  securityResult: RuntimeEmbedRenderResult["security"];
}> {
  const autoPinEnabled = options.autoPinLatestModuleManifest !== false;
  const precheckResult = await precheckPlanBeforeAutoPin(
    plan,
    security,
    autoPinEnabled,
  );
  if (!precheckResult.safe) {
    throw new RuntimeSecurityViolationError(precheckResult);
  }

  const planForExecution = await autoPinRuntimePlanModuleManifest(plan, {
    enabled: autoPinEnabled,
    moduleLoader,
    fetchTimeoutMs: options.autoPinFetchTimeoutMs,
    signal: options.signal,
  });

  if (!autoPinEnabled) {
    return {
      planForExecution,
      securityResult: precheckResult,
    };
  }

  const securityResult = await security.checkPlan(planForExecution);
  if (!securityResult.safe) {
    throw new RuntimeSecurityViolationError(securityResult);
  }

  return {
    planForExecution,
    securityResult,
  };
}

async function precheckPlanBeforeAutoPin(
  plan: RuntimePlan,
  security: NonNullable<RuntimeEmbedRenderOptions["security"]>,
  autoPinEnabled: boolean,
): Promise<RuntimeEmbedRenderResult["security"]> {
  if (!autoPinEnabled) {
    return security.checkPlan(plan);
  }

  const policy = security.getPolicy();
  if (!policy.requireModuleManifestForBareSpecifiers) {
    return security.checkPlan(plan);
  }

  const precheckSecurity = new DefaultSecurityChecker();
  precheckSecurity.initialize({
    overrides: {
      ...policy,
      allowedModules: ["", ...policy.allowedModules],
      requireModuleManifestForBareSpecifiers: false,
    },
  });

  return precheckSecurity.checkPlan(plan);
}

function mergeSecurityInitializationProfile(
  input: RuntimeEmbedRenderOptions["securityInitialization"],
  profile: RuntimeSecurityProfile,
): RuntimeEmbedRenderOptions["securityInitialization"] {
  if (input === undefined) {
    return { profile };
  }

  if (isSecurityInitializationOptions(input)) {
    return {
      ...input,
      profile: input.profile ?? profile,
    };
  }

  return {
    profile,
    overrides: {
      ...input,
    },
  };
}

function isSecurityInitializationOptions(
  value: RuntimeEmbedRenderOptions["securityInitialization"],
): value is SecurityInitializationOptions {
  return Boolean(
    value &&
      typeof value === "object" &&
      ("profile" in value || "overrides" in value),
  );
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
