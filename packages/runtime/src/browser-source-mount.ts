import type { RuntimeDiagnostic, RuntimePlan } from "@renderify/ir";
import { renderPlanInBrowser } from "./embed";
import type { RuntimeEmbedRenderOptions } from "./runtime-manager.types";
import { DefaultUIRenderer } from "./ui-renderer";

export interface PlaygroundBrowserRuntimeConfig {
  securityInitialization: RuntimeEmbedRenderOptions["securityInitialization"];
  runtimeOptions: RuntimeEmbedRenderOptions["runtimeOptions"];
}

export interface PlaygroundBrowserMountInput {
  plan: RuntimePlan;
  framework: "preact" | "react";
  rendererUrl: string;
  rendererDomClientUrl?: string;
  rendererDomUrl?: string;
  target: HTMLElement;
  config: PlaygroundBrowserRuntimeConfig;
}

export interface PlaygroundBrowserMountResult {
  diagnostics: RuntimeDiagnostic[];
  html: string;
}

interface BrowserRenderer {
  render(vnode: unknown, parent: Element): void;
}

interface BrowserComponentModule {
  h(type: unknown, props: unknown, ...children: unknown[]): unknown;
}

let activeMount:
  | {
      renderer: BrowserRenderer;
      target: HTMLElement;
    }
  | undefined;
let mountGeneration = 0;

export async function mountBrowserSourceExecution(
  input: PlaygroundBrowserMountInput,
): Promise<PlaygroundBrowserMountResult> {
  const generation = ++mountGeneration;
  unmountActive();

  const { componentModule, renderer } =
    await loadBrowserFrameworkRuntime(input);
  if (generation !== mountGeneration) {
    throw new Error("Browser render was superseded before mounting");
  }

  const ui = new DefaultUIRenderer({
    loadPreactRenderer: () => renderer,
  });
  input.target.replaceChildren();

  try {
    const result = await renderPlanInBrowser(input.plan, {
      target: input.target,
      ui,
      autoPinLatestModuleManifest: false,
      securityInitialization: input.config.securityInitialization,
      runtimeOptions: {
        ...(input.config.runtimeOptions ?? {}),
        loadPreactModule: () => componentModule,
      },
    });

    if (generation !== mountGeneration) {
      renderer.render(null, input.target);
      throw new Error("Browser render was superseded while mounting");
    }
    if (result.execution.renderArtifact?.mode !== "preact-vnode") {
      const detail = result.execution.diagnostics
        .filter((diagnostic) => diagnostic.level === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ");
      throw new Error(
        detail || "Preact source did not produce a browser render artifact",
      );
    }

    activeMount = {
      renderer,
      target: input.target,
    };
    return {
      diagnostics: result.execution.diagnostics,
      html: input.target.innerHTML,
    };
  } catch (error) {
    renderer.render(null, input.target);
    throw error;
  }
}

export function unmountBrowserSourceExecution(): void {
  mountGeneration += 1;
  unmountActive();
}

function unmountActive(): void {
  if (!activeMount) {
    return;
  }

  activeMount.renderer.render(null, activeMount.target);
  activeMount = undefined;
}

async function loadBrowserFrameworkRuntime(
  input: PlaygroundBrowserMountInput,
): Promise<{
  componentModule: BrowserComponentModule;
  renderer: BrowserRenderer;
}> {
  if (input.framework === "react") {
    return loadReactBrowserRuntime(input);
  }

  const loaded = (await import(
    /* @vite-ignore */ input.rendererUrl
  )) as unknown;
  if (!isPreactRuntimeModule(loaded)) {
    throw new Error(`Browser Preact runtime is invalid: ${input.rendererUrl}`);
  }
  return {
    componentModule: loaded,
    renderer: loaded,
  };
}

async function loadReactBrowserRuntime(
  input: PlaygroundBrowserMountInput,
): Promise<{
  componentModule: BrowserComponentModule;
  renderer: BrowserRenderer;
}> {
  if (!input.rendererDomClientUrl || !input.rendererDomUrl) {
    throw new Error("Browser React runtime URLs are incomplete");
  }

  const [react, reactDomClient, reactDom] = (await Promise.all([
    import(/* @vite-ignore */ input.rendererUrl),
    import(/* @vite-ignore */ input.rendererDomClientUrl),
    import(/* @vite-ignore */ input.rendererDomUrl),
  ])) as unknown[];
  if (!isReactRuntimeModule(react)) {
    throw new Error(`Browser React runtime is invalid: ${input.rendererUrl}`);
  }
  if (!isReactDomClientModule(reactDomClient)) {
    throw new Error(
      `Browser React DOM client is invalid: ${input.rendererDomClientUrl}`,
    );
  }

  const roots = new WeakMap<Element, ReactRoot>();
  const flushSync = resolveReactFlushSync(reactDom);
  const renderer: BrowserRenderer = {
    render(vnode, parent) {
      const existing = roots.get(parent);
      if (vnode === null || vnode === undefined) {
        if (existing) {
          flushSync(() => existing.unmount());
          roots.delete(parent);
        }
        return;
      }

      const root = existing ?? reactDomClient.createRoot(parent);
      if (!existing) {
        roots.set(parent, root);
      }
      flushSync(() => root.render(vnode));
    },
  };

  return {
    componentModule: {
      h: react.createElement,
    },
    renderer,
  };
}

interface ReactRoot {
  render(vnode: unknown): void;
  unmount(): void;
}

function isPreactRuntimeModule(
  value: unknown,
): value is BrowserRenderer & BrowserComponentModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { h?: unknown; render?: unknown };
  return (
    typeof candidate.h === "function" && typeof candidate.render === "function"
  );
}

function isReactRuntimeModule(
  value: unknown,
): value is { createElement: BrowserComponentModule["h"] } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createElement?: unknown }).createElement === "function"
  );
}

function isReactDomClientModule(
  value: unknown,
): value is { createRoot(parent: Element): ReactRoot } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createRoot?: unknown }).createRoot === "function"
  );
}

function resolveReactFlushSync(
  value: unknown,
): (operation: () => void) => void {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { flushSync?: unknown }).flushSync === "function"
  ) {
    return (value as { flushSync(operation: () => void): void }).flushSync;
  }
  return (operation) => operation();
}
