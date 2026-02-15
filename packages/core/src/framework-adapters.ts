import type { RuntimePlan } from "@renderify/ir";
import type { CodeGenerationInput } from "./codegen";
import type { RenderifyPlugin } from "./customization";

export type FrameworkAdapterName = "vue" | "svelte" | "solid";

export interface FrameworkAdapterPluginOptions {
  runtimeImportPath?: string;
  forcePreactRuntime?: boolean;
}

const DEFAULT_RUNTIME_IMPORT_PATH = "@renderify/runtime";

export function createFrameworkAdapterPlugin(
  framework: FrameworkAdapterName,
  options: FrameworkAdapterPluginOptions = {},
): RenderifyPlugin {
  const runtimeImportPath =
    normalizeString(options.runtimeImportPath) ?? DEFAULT_RUNTIME_IMPORT_PATH;
  const forcePreactRuntime = options.forcePreactRuntime !== false;

  return {
    name: `framework-adapter:${framework}`,
    hooks: {
      beforeLLM(prompt) {
        if (typeof prompt !== "string") {
          return prompt;
        }

        return [
          prompt,
          "",
          buildFrameworkInstructions(framework, runtimeImportPath),
        ].join("\n");
      },
      beforeCodeGen(payload) {
        if (!isCodeGenerationInput(payload)) {
          return payload;
        }

        return {
          ...payload,
          llmText: normalizeFrameworkCodeFences(payload.llmText, framework),
        };
      },
      afterCodeGen(payload) {
        if (!isRuntimePlan(payload)) {
          return payload;
        }

        const metadata = {
          ...asRecord(payload.metadata),
          frameworkAdapter: {
            framework,
            runtimeImportPath,
          },
        };

        const source =
          forcePreactRuntime && isJsxLikeSource(payload.source)
            ? {
                ...payload.source,
                runtime: "preact" as const,
              }
            : payload.source;

        return {
          ...payload,
          source,
          metadata,
        };
      },
    },
  };
}

export function createVueAdapterPlugin(
  options?: FrameworkAdapterPluginOptions,
): RenderifyPlugin {
  return createFrameworkAdapterPlugin("vue", options);
}

export function createSvelteAdapterPlugin(
  options?: FrameworkAdapterPluginOptions,
): RenderifyPlugin {
  return createFrameworkAdapterPlugin("svelte", options);
}

export function createSolidAdapterPlugin(
  options?: FrameworkAdapterPluginOptions,
): RenderifyPlugin {
  return createFrameworkAdapterPlugin("solid", options);
}

function buildFrameworkInstructions(
  framework: FrameworkAdapterName,
  runtimeImportPath: string,
): string {
  const adapterComponent = frameworkAdapterComponentName(framework);

  return [
    `Framework adapter target: ${framework}.`,
    "Return TSX/JSX only (no .vue/.svelte single-file format).",
    `Use \`${adapterComponent}\` from \`${runtimeImportPath}\` when mounting framework-native components.`,
    "Keep output as browser ESM imports so Runtime source execution can run directly.",
  ].join("\n");
}

function frameworkAdapterComponentName(
  framework: FrameworkAdapterName,
): "VueAdapter" | "SvelteAdapter" | "SolidAdapter" {
  if (framework === "vue") {
    return "VueAdapter";
  }

  if (framework === "svelte") {
    return "SvelteAdapter";
  }

  return "SolidAdapter";
}

function normalizeFrameworkCodeFences(
  llmText: string,
  framework: FrameworkAdapterName,
): string {
  if (llmText.trim().length === 0) {
    return llmText;
  }

  const languageTags = frameworkFenceTags(framework);
  let normalized = llmText;

  for (const languageTag of languageTags) {
    const regex = new RegExp("```\\s*" + languageTag + "(?=\\s|$)", "gi");
    normalized = normalized.replace(regex, "```tsx");
  }

  return normalized;
}

function frameworkFenceTags(framework: FrameworkAdapterName): string[] {
  if (framework === "vue") {
    return ["vue"];
  }

  if (framework === "svelte") {
    return ["svelte"];
  }

  return ["solid", "solid-js", "solidjs"];
}

function isCodeGenerationInput(value: unknown): value is CodeGenerationInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CodeGenerationInput>;
  return (
    typeof candidate.prompt === "string" &&
    typeof candidate.llmText === "string"
  );
}

function isRuntimePlan(value: unknown): value is RuntimePlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimePlan>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.version === "number" &&
    typeof candidate.root === "object" &&
    candidate.root !== null
  );
}

function isJsxLikeSource(source: RuntimePlan["source"]): boolean {
  if (!source) {
    return false;
  }

  return source.language === "jsx" || source.language === "tsx";
}

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
