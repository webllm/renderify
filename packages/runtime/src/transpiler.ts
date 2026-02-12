import type {
  RuntimeSourceTranspileInput,
  RuntimeSourceTranspiler,
} from "./runtime-manager.types";

interface BabelStandaloneLike {
  transform(
    code: string,
    options: {
      sourceType?: "module";
      presets?: unknown[];
      filename?: string;
      babelrc?: boolean;
      configFile?: boolean;
      comments?: boolean;
    },
  ): {
    code?: string;
  };
}

const RUNTIME_JSX_HELPERS = `
function __renderify_runtime_to_nodes(value) {
  if (value === null || value === undefined || value === false || value === true) {
    return [];
  }
  if (Array.isArray(value)) {
    const flattened = [];
    for (const entry of value) {
      flattened.push(...__renderify_runtime_to_nodes(entry));
    }
    return flattened;
  }
  if (typeof value === "string" || typeof value === "number") {
    return [{ type: "text", value: String(value) }];
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  ) {
    return [value];
  }
  return [{ type: "text", value: String(value) }];
}

function __renderify_runtime_h(type, props, ...children) {
  const normalizedChildren = __renderify_runtime_to_nodes(children);
  if (typeof type === "function") {
    const output = type({ ...(props || {}), children: normalizedChildren });
    const functionNodes = __renderify_runtime_to_nodes(output);
    if (functionNodes.length === 1) {
      return functionNodes[0];
    }
    return { type: "element", tag: "div", children: functionNodes };
  }
  if (typeof type === "string") {
    return {
      type: "element",
      tag: type,
      props: props || undefined,
      children: normalizedChildren,
    };
  }
  return { type: "text", value: "Unsupported JSX node type" };
}

function __renderify_runtime_fragment(...children) {
  return __renderify_runtime_to_nodes(children);
}
`.trim();

export class BabelRuntimeSourceTranspiler implements RuntimeSourceTranspiler {
  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    if (input.language === "js") {
      return input.code;
    }

    const babel = this.resolveBabel();
    const presets: unknown[] = [];

    if (input.language === "ts" || input.language === "tsx") {
      presets.push("typescript");
    }

    if (input.language === "jsx" || input.language === "tsx") {
      if (input.runtime === "preact") {
        presets.push([
          "react",
          {
            runtime: "automatic",
            importSource: "preact",
          },
        ]);
      } else {
        presets.push([
          "react",
          {
            runtime: "classic",
            pragma: "__renderify_runtime_h",
            pragmaFrag: "__renderify_runtime_fragment",
          },
        ]);
      }
    }

    const transformed = babel.transform(input.code, {
      sourceType: "module",
      presets,
      filename: input.filename,
      babelrc: false,
      configFile: false,
      comments: false,
    });

    if (!transformed.code) {
      throw new Error("Babel returned empty output");
    }

    return transformed.code;
  }

  private resolveBabel(): BabelStandaloneLike {
    const root = globalThis as unknown as {
      Babel?: BabelStandaloneLike;
    };

    if (root.Babel && typeof root.Babel.transform === "function") {
      return root.Babel;
    }

    throw new Error(
      "Babel standalone is not available. Load @babel/standalone in browser or provide sourceTranspiler.",
    );
  }

  static mergeRuntimeHelpers(
    source: RuntimeSourceTranspileInput["code"],
    runtime: RuntimeSourceTranspileInput["runtime"],
  ): string {
    if (runtime === "preact") {
      return source;
    }

    return `${source}\n\n${RUNTIME_JSX_HELPERS}`;
  }
}
