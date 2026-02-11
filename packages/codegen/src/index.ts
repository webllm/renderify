import {
  collectComponentModules,
  createElementNode,
  createTextNode,
  isRuntimeCapabilities,
  isRuntimeNode,
  isRuntimePlanMetadata,
  isRuntimeSourceModule,
  isRuntimeStateModel,
  type RuntimeCapabilities,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimePlanMetadata,
  type RuntimeSourceModule,
  type RuntimeStateModel,
} from "@renderify/ir";

export interface CodeGenerationInput {
  prompt: string;
  llmText: string;
  context?: Record<string, unknown>;
}

export interface CodeGenerator {
  generatePlan(input: CodeGenerationInput): Promise<RuntimePlan>;
  validatePlan(plan: RuntimePlan): Promise<boolean>;
  transformPlan(
    plan: RuntimePlan,
    transforms: Array<(plan: RuntimePlan) => RuntimePlan>,
  ): Promise<RuntimePlan>;
}

export class DefaultCodeGenerator implements CodeGenerator {
  async generatePlan(input: CodeGenerationInput): Promise<RuntimePlan> {
    const parsedPlan = this.tryParseRuntimePlan(input.llmText, input.prompt);
    if (parsedPlan) {
      return parsedPlan;
    }

    const source = this.tryExtractRuntimeSource(input.llmText);
    if (source) {
      return this.createSourcePlan(input.prompt, source);
    }

    const parsedRoot = this.tryParseRuntimeNode(input.llmText);
    const root =
      parsedRoot ?? this.createFallbackRoot(input.prompt, input.llmText);
    const imports = collectComponentModules(root);

    return this.createPlanFromRoot(root, {
      prompt: input.prompt,
      imports,
      capabilities: {
        domWrite: true,
        allowedModules: imports,
      },
    });
  }

  async validatePlan(plan: RuntimePlan): Promise<boolean> {
    if (!plan.id || !Number.isInteger(plan.version) || plan.version <= 0) {
      return false;
    }

    if (!isRuntimeNode(plan.root)) {
      return false;
    }

    return typeof plan.capabilities === "object" && plan.capabilities !== null;
  }

  async transformPlan(
    plan: RuntimePlan,
    transforms: Array<(plan: RuntimePlan) => RuntimePlan>,
  ): Promise<RuntimePlan> {
    return transforms.reduce((current, transform) => transform(current), plan);
  }

  private createFallbackRoot(prompt: string, llmText: string): RuntimeNode {
    const title = prompt.trim().length > 0 ? prompt.trim() : "Untitled prompt";
    const summary =
      llmText.trim().length > 0 ? llmText.trim() : "No model output";

    return createElementNode("section", { class: "renderify-runtime-output" }, [
      createElementNode("h1", undefined, [createTextNode(title)]),
      createElementNode("p", undefined, [createTextNode(summary)]),
    ]);
  }

  private createPlanFromRoot(
    root: RuntimeNode,
    input: {
      prompt: string;
      imports?: string[];
      capabilities?: RuntimeCapabilities;
      metadata?: RuntimePlanMetadata;
      id?: string;
      version?: number;
      state?: RuntimeStateModel;
      source?: RuntimeSourceModule;
    },
  ): RuntimePlan {
    const imports =
      this.normalizeImports(input.imports) ?? collectComponentModules(root);
    const capabilities = this.normalizeCapabilities(
      input.capabilities,
      imports,
    );
    const metadata = this.normalizeMetadata(input.prompt, input.metadata);
    const id = this.normalizePlanId(input.id);
    const version = this.normalizePlanVersion(input.version);

    return {
      id,
      version,
      root,
      imports,
      capabilities,
      ...(metadata ? { metadata } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.source ? { source: input.source } : {}),
    };
  }

  private tryParseRuntimePlan(
    text: string,
    prompt: string,
  ): RuntimePlan | undefined {
    const parsed = this.tryParseJsonPayload(text);
    if (!this.isRecord(parsed) || !("root" in parsed)) {
      return undefined;
    }

    const root = parsed.root;
    if (!isRuntimeNode(root)) {
      return undefined;
    }

    const metadata = this.isRecord(parsed.metadata)
      ? isRuntimePlanMetadata(parsed.metadata)
        ? parsed.metadata
        : undefined
      : undefined;

    const state =
      this.isRecord(parsed.state) && isRuntimeStateModel(parsed.state)
        ? parsed.state
        : undefined;
    const source =
      this.isRecord(parsed.source) && isRuntimeSourceModule(parsed.source)
        ? parsed.source
        : undefined;
    const importsFromPayload = Array.isArray(parsed.imports)
      ? (parsed.imports as unknown[])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined;
    const imports =
      importsFromPayload ??
      (source ? this.parseImportsFromSource(source.code) : undefined);

    return this.createPlanFromRoot(root, {
      prompt,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      version: typeof parsed.version === "number" ? parsed.version : undefined,
      imports,
      capabilities:
        this.isRecord(parsed.capabilities) &&
        isRuntimeCapabilities(parsed.capabilities)
          ? parsed.capabilities
          : undefined,
      metadata,
      state,
      source,
    });
  }

  private tryParseRuntimeNode(text: string): RuntimeNode | undefined {
    const parsed = this.tryParseJsonPayload(text);
    if (isRuntimeNode(parsed)) {
      return parsed;
    }

    return undefined;
  }

  private tryParseJsonPayload(text: string): unknown {
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    const payload = codeBlockMatch ? codeBlockMatch[1] : text;
    const trimmed = payload.trim();

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }

  private normalizePlanId(id?: string): string {
    if (typeof id === "string" && id.trim().length > 0) {
      return id.trim();
    }

    return `plan_${Date.now().toString(36)}`;
  }

  private normalizePlanVersion(version?: number): number {
    if (Number.isInteger(version) && (version as number) > 0) {
      return version as number;
    }

    return 1;
  }

  private normalizeImports(imports?: string[]): string[] | undefined {
    if (!imports || imports.length === 0) {
      return undefined;
    }

    return [...new Set(imports)];
  }

  private normalizeCapabilities(
    capabilities: RuntimeCapabilities | undefined,
    imports: string[],
  ): RuntimeCapabilities {
    const normalized: RuntimeCapabilities = {
      domWrite: true,
      allowedModules: imports,
      ...(capabilities ?? {}),
    };

    if (!Array.isArray(normalized.allowedModules)) {
      normalized.allowedModules = imports;
    }

    if (
      typeof normalized.maxImports === "number" &&
      (!Number.isFinite(normalized.maxImports) || normalized.maxImports < 0)
    ) {
      delete normalized.maxImports;
    }

    if (
      typeof normalized.maxExecutionMs === "number" &&
      (!Number.isFinite(normalized.maxExecutionMs) ||
        normalized.maxExecutionMs < 1)
    ) {
      delete normalized.maxExecutionMs;
    }

    if (
      typeof normalized.maxComponentInvocations === "number" &&
      (!Number.isFinite(normalized.maxComponentInvocations) ||
        normalized.maxComponentInvocations < 0)
    ) {
      delete normalized.maxComponentInvocations;
    }

    return normalized;
  }

  private normalizeMetadata(
    prompt: string,
    metadata?: RuntimePlanMetadata,
  ): RuntimePlanMetadata | undefined {
    const sourcePrompt = prompt.trim().length > 0 ? prompt.trim() : undefined;
    const merged = {
      ...(metadata ?? {}),
      ...(sourcePrompt ? { sourcePrompt } : {}),
    } as RuntimePlanMetadata;

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private tryExtractRuntimeSource(
    text: string,
  ): RuntimeSourceModule | undefined {
    const match = text.match(/```(tsx|jsx|ts|js)\s*([\s\S]*?)\s*```/i);

    if (!match) {
      return undefined;
    }

    const language = match[1].toLowerCase() as RuntimeSourceModule["language"];
    const code = match[2].trim();
    if (code.length === 0) {
      return undefined;
    }

    return {
      language,
      code,
      exportName: "default",
    };
  }

  private createSourcePlan(
    prompt: string,
    source: RuntimeSourceModule,
  ): RuntimePlan {
    const imports = this.parseImportsFromSource(source.code);

    return this.createPlanFromRoot(
      createElementNode("section", { class: "renderify-runtime-source-plan" }, [
        createElementNode("h2", undefined, [createTextNode(prompt)]),
        createElementNode("p", undefined, [
          createTextNode(`Runtime source module (${source.language}) prepared`),
        ]),
      ]),
      {
        prompt,
        imports,
        capabilities: {
          domWrite: true,
          allowedModules: imports,
        },
        metadata: {
          sourcePrompt: prompt,
          tags: ["source-module", source.language],
        },
        source,
      },
    );
  }

  private parseImportsFromSource(code: string): string[] {
    const imports = new Set<string>();
    const staticImportRegex =
      /\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g;
    const dynamicImportRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

    for (const regex of [staticImportRegex, dynamicImportRegex]) {
      let match: RegExpExecArray | null;
      match = regex.exec(code);
      while (match !== null) {
        const specifier = match[1].trim();
        if (specifier.length === 0) {
          match = regex.exec(code);
          continue;
        }

        imports.add(specifier);
        match = regex.exec(code);
      }
    }

    return [...imports];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
