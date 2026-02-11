export type PluginHook =
  | "beforeLLM"
  | "afterLLM"
  | "beforeCodeGen"
  | "afterCodeGen"
  | "beforePolicyCheck"
  | "afterPolicyCheck"
  | "beforeRuntime"
  | "afterRuntime"
  | "beforeRender"
  | "afterRender";

export interface PluginContext {
  traceId: string;
  hookName: PluginHook;
}

export type PluginHandler<Payload = unknown> = (
  payload: Payload,
  context: PluginContext
) => Payload | Promise<Payload>;

export interface RenderifyPlugin {
  name: string;
  hooks: Partial<Record<PluginHook, PluginHandler>>;
}

export interface CustomizationEngine {
  registerPlugin(plugin: RenderifyPlugin): void;
  getPlugins(): RenderifyPlugin[];
  runHook<Payload>(
    hookName: PluginHook,
    payload: Payload,
    context: PluginContext
  ): Promise<Payload>;
}

export class DefaultCustomizationEngine implements CustomizationEngine {
  private plugins: RenderifyPlugin[] = [];

  registerPlugin(plugin: RenderifyPlugin) {
    this.plugins.push(plugin);
  }

  getPlugins(): RenderifyPlugin[] {
    return [...this.plugins];
  }

  async runHook<Payload>(
    hookName: PluginHook,
    payload: Payload,
    context: PluginContext
  ): Promise<Payload> {
    let currentPayload = payload;

    for (const plugin of this.plugins) {
      const hookFn = plugin.hooks[hookName];
      if (!hookFn) {
        continue;
      }

      currentPayload = (await hookFn(currentPayload, context)) as Payload;
    }

    return currentPayload;
  }
}
