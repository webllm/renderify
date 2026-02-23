import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";

export interface FrameworkAdapterBaseProps<TComponent = unknown> {
  component: TComponent;
  props?: Record<string, unknown>;
  className?: string;
  fallbackText?: string;
}

export interface VueRuntimeModule {
  createApp(
    component: unknown,
    props?: Record<string, unknown>,
  ): {
    mount(target: Element): unknown;
    unmount(): void;
  };
}

export interface SolidRuntimeModule {
  render(component: () => unknown, target: Element): (() => void) | void;
}

export interface SvelteComponentInstance {
  $destroy(): void;
}

export interface SvelteComponentConstructor {
  new (options: {
    target: Element;
    props?: Record<string, unknown>;
  }): SvelteComponentInstance;
}

export interface VueAdapterProps extends FrameworkAdapterBaseProps<unknown> {
  loadVue?: () => Promise<VueRuntimeModule>;
}

export interface SolidAdapterProps extends FrameworkAdapterBaseProps<unknown> {
  loadSolidWeb?: () => Promise<SolidRuntimeModule>;
}

export interface SvelteAdapterProps
  extends FrameworkAdapterBaseProps<SvelteComponentConstructor> {
  loadSvelte?: () => Promise<unknown>;
}

const defaultFallbackText = "Failed to mount framework component";

export function VueAdapter(props: VueAdapterProps) {
  const {
    component,
    props: componentProps,
    className,
    fallbackText = defaultFallbackText,
    loadVue = loadVueRuntime,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    const mount = async (): Promise<void> => {
      const mountPoint = mountRef.current;
      if (!mountPoint || disposed) {
        return;
      }

      const runtime = await loadVue();
      if (disposed || !mountRef.current) {
        return;
      }

      const app = runtime.createApp(component, componentProps);
      app.mount(mountRef.current);
      teardown = () => {
        app.unmount();
      };
    };

    void mount().catch((error) => {
      reportFrameworkMountError(mountRef.current, fallbackText, error);
    });

    return () => {
      disposed = true;
      if (teardown) {
        teardown();
      }
      clearMountPoint(mountRef.current);
    };
  }, [component, componentProps, fallbackText, loadVue]);

  return h("div", {
    ref: mountRef,
    class: className,
    "data-renderify-framework": "vue",
  });
}

export function SolidAdapter(props: SolidAdapterProps) {
  const {
    component,
    props: componentProps,
    className,
    fallbackText = defaultFallbackText,
    loadSolidWeb = loadSolidRuntime,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    const mount = async (): Promise<void> => {
      const mountPoint = mountRef.current;
      if (!mountPoint || disposed) {
        return;
      }

      const runtime = await loadSolidWeb();
      if (disposed || !mountRef.current) {
        return;
      }

      const normalizedComponent =
        typeof component === "function"
          ? () =>
              (component as (props?: Record<string, unknown>) => unknown)(
                componentProps,
              )
          : () => component;

      const maybeTeardown = runtime.render(
        normalizedComponent,
        mountRef.current,
      );
      if (typeof maybeTeardown === "function") {
        teardown = maybeTeardown;
      }
    };

    void mount().catch((error) => {
      reportFrameworkMountError(mountRef.current, fallbackText, error);
    });

    return () => {
      disposed = true;
      if (teardown) {
        teardown();
      }
      clearMountPoint(mountRef.current);
    };
  }, [component, componentProps, fallbackText, loadSolidWeb]);

  return h("div", {
    ref: mountRef,
    class: className,
    "data-renderify-framework": "solid",
  });
}

export function SvelteAdapter(props: SvelteAdapterProps) {
  const {
    component,
    props: componentProps,
    className,
    fallbackText = defaultFallbackText,
    loadSvelte = loadSvelteRuntime,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let instance: SvelteComponentInstance | undefined;

    const mount = async (): Promise<void> => {
      const mountPoint = mountRef.current;
      if (!mountPoint || disposed) {
        return;
      }

      await loadSvelte();
      if (disposed || !mountRef.current) {
        return;
      }

      instance = new component({
        target: mountRef.current,
        props: componentProps,
      });
    };

    void mount().catch((error) => {
      reportFrameworkMountError(mountRef.current, fallbackText, error);
    });

    return () => {
      disposed = true;
      if (instance) {
        instance.$destroy();
      }
      clearMountPoint(mountRef.current);
    };
  }, [component, componentProps, fallbackText, loadSvelte]);

  return h("div", {
    ref: mountRef,
    class: className,
    "data-renderify-framework": "svelte",
  });
}

async function loadVueRuntime(): Promise<VueRuntimeModule> {
  return (await dynamicImport("vue")) as VueRuntimeModule;
}

async function loadSolidRuntime(): Promise<SolidRuntimeModule> {
  return (await dynamicImport("solid-js/web")) as SolidRuntimeModule;
}

async function loadSvelteRuntime(): Promise<unknown> {
  return dynamicImport("svelte");
}

function reportFrameworkMountError(
  mountPoint: HTMLDivElement | null,
  fallbackText: string,
  error: unknown,
): void {
  if (!mountPoint) {
    return;
  }

  clearMountPoint(mountPoint);
  mountPoint.textContent = fallbackText;
  mountPoint.setAttribute(
    "data-renderify-framework-error",
    error instanceof Error ? error.message : String(error),
  );
}

function clearMountPoint(mountPoint: HTMLDivElement | null): void {
  if (!mountPoint) {
    return;
  }

  mountPoint.innerHTML = "";
}

async function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}
