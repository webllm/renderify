import type { LLMInterpreter } from "@renderify/core";
import {
  OpenAILLMInterpreter,
  type OpenAILLMInterpreterOptions,
} from "./providers/openai";

export type LLMProviderName = string;

export interface LLMProviderDefinition<
  TOptions extends object = Record<string, unknown>,
> {
  name: LLMProviderName;
  create(options?: TOptions): LLMInterpreter;
}

export const openaiLLMProvider: LLMProviderDefinition<OpenAILLMInterpreterOptions> =
  {
    name: "openai",
    create: (options) => new OpenAILLMInterpreter(options),
  };

export class LLMProviderRegistry {
  private readonly providers = new Map<string, LLMProviderDefinition>();

  register(definition: LLMProviderDefinition): this {
    const key = normalizeProviderName(definition.name);
    this.providers.set(key, definition);
    return this;
  }

  unregister(providerName: string): boolean {
    return this.providers.delete(normalizeProviderName(providerName));
  }

  has(providerName: string): boolean {
    return this.providers.has(normalizeProviderName(providerName));
  }

  list(): string[] {
    return [...this.providers.keys()].sort((a, b) => a.localeCompare(b));
  }

  resolve(providerName: string): LLMProviderDefinition | undefined {
    return this.providers.get(normalizeProviderName(providerName));
  }

  create(
    providerName: string,
    options?: Record<string, unknown>,
  ): LLMInterpreter {
    const provider = this.resolve(providerName);
    if (!provider) {
      const available = this.list();
      const hint =
        available.length > 0
          ? ` Available providers: ${available.join(", ")}.`
          : " No providers registered.";
      throw new Error(`Unknown LLM provider: ${providerName}.${hint}`);
    }

    return provider.create(options);
  }
}

export function createDefaultLLMProviderRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(openaiLLMProvider);
  return registry;
}

export const defaultLLMProviderRegistry = createDefaultLLMProviderRegistry();

export function createLLMInterpreter(options: {
  provider?: string;
  providerOptions?: Record<string, unknown>;
  registry?: LLMProviderRegistry;
}): LLMInterpreter {
  const provider = normalizeProviderName(options.provider ?? "openai");
  const registry = options.registry ?? defaultLLMProviderRegistry;

  return registry.create(provider, options.providerOptions);
}

function normalizeProviderName(providerName: string): string {
  const normalized = String(providerName).trim().toLowerCase();
  if (normalized.length === 0) {
    return "openai";
  }

  return normalized;
}
