import {
  collectComponentModules,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  isRuntimeCapabilities,
  isRuntimeModuleManifest,
  isRuntimeNode,
  isRuntimePlanMetadata,
  isRuntimeSourceModule,
  isRuntimeStateModel,
  type RuntimeCapabilities,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimePlan,
  type RuntimePlanMetadata,
  type RuntimeSourceModule,
  type RuntimeSourceRuntime,
  type RuntimeStateModel,
  resolveRuntimePlanSpecVersion,
} from "@renderify/ir";

export interface CodeGenerationInput {
  prompt: string;
  llmText: string;
  context?: Record<string, unknown>;
}

export interface IncrementalCodeGenerationInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface IncrementalCodeGenerationUpdate {
  plan: RuntimePlan;
  complete: boolean;
  mode:
    | "runtime-plan-json"
    | "runtime-node-json"
    | "runtime-source"
    | "runtime-text-fallback";
}

export interface IncrementalCodeGenerationSession {
  pushDelta(
    delta: string,
  ): Promise<IncrementalCodeGenerationUpdate | undefined>;
  finalize(finalText?: string): Promise<RuntimePlan | undefined>;
}

export interface CodeGenerator {
  generatePlan(input: CodeGenerationInput): Promise<RuntimePlan>;
  createIncrementalSession?(
    input: IncrementalCodeGenerationInput,
  ): IncrementalCodeGenerationSession;
  validatePlan(plan: RuntimePlan): Promise<boolean>;
  transformPlan(
    plan: RuntimePlan,
    transforms: Array<(plan: RuntimePlan) => RuntimePlan>,
  ): Promise<RuntimePlan>;
}

const JSPM_SPECIFIER_OVERRIDES: Record<string, string> = {
  preact: "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
  "preact/hooks":
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
  "preact/compat":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "preact/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  react: "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react-dom/client":
    "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
  "react/jsx-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  "react/jsx-dev-runtime":
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  recharts: "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
};

export class DefaultCodeGenerator implements CodeGenerator {
  createIncrementalSession(
    input: IncrementalCodeGenerationInput,
  ): IncrementalCodeGenerationSession {
    let buffer = "";
    let lastSignature = "";

    const tryGenerate = (): IncrementalCodeGenerationUpdate | undefined => {
      const candidate = this.tryBuildIncrementalCandidate(input.prompt, buffer);
      if (!candidate) {
        return undefined;
      }

      const signature = this.createIncrementalPlanSignature(candidate.plan);
      if (signature === lastSignature) {
        return undefined;
      }

      lastSignature = signature;
      return candidate;
    };

    return {
      pushDelta: async (delta: string) => {
        if (delta.length > 0) {
          buffer += delta;
        }

        return tryGenerate();
      },
      finalize: async (finalText?: string) => {
        if (typeof finalText === "string" && finalText.length > 0) {
          buffer = finalText;
        }

        const candidate = tryGenerate();
        return candidate?.plan;
      },
    };
  }

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

  private tryBuildIncrementalCandidate(
    prompt: string,
    llmText: string,
  ): IncrementalCodeGenerationUpdate | undefined {
    const parsedPlan = this.tryParseRuntimePlan(llmText, prompt);
    if (parsedPlan) {
      return {
        plan: parsedPlan,
        complete: this.isLikelyCompleteJsonPayload(llmText),
        mode: "runtime-plan-json",
      };
    }

    const parsedNode = this.tryParseRuntimeNode(llmText);
    if (parsedNode) {
      return {
        plan: this.createPlanFromRoot(parsedNode, {
          prompt,
          imports: collectComponentModules(parsedNode),
          capabilities: {
            domWrite: true,
            allowedModules: collectComponentModules(parsedNode),
          },
        }),
        complete: this.isLikelyCompleteJsonPayload(llmText),
        mode: "runtime-node-json",
      };
    }

    const source = this.tryExtractRuntimeSource(llmText);
    if (source) {
      return {
        plan: this.createSourcePlan(prompt, source),
        complete: this.hasClosedCodeFence(llmText),
        mode: "runtime-source",
      };
    }

    const fallbackRoot = this.createFallbackRoot(prompt, llmText);
    const fallbackImports = collectComponentModules(fallbackRoot);
    return {
      plan: this.createPlanFromRoot(fallbackRoot, {
        prompt,
        imports: fallbackImports,
        capabilities: {
          domWrite: true,
          allowedModules: fallbackImports,
        },
      }),
      complete: false,
      mode: "runtime-text-fallback",
    };
  }

  private createIncrementalPlanSignature(plan: RuntimePlan): string {
    return JSON.stringify({
      root: plan.root,
      imports: plan.imports ?? [],
      source: plan.source,
      capabilities: plan.capabilities,
      state: plan.state,
    });
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
      specVersion?: string;
      state?: RuntimeStateModel;
      moduleManifest?: RuntimeModuleManifest;
      source?: RuntimeSourceModule;
    },
  ): RuntimePlan {
    const imports =
      this.normalizeImports(input.imports) ?? collectComponentModules(root);
    const source = this.normalizeSourceModule(input.source);
    const moduleManifest =
      this.normalizeModuleManifest(input.moduleManifest) ??
      this.createModuleManifestFromImports(imports);
    const capabilities = this.normalizeCapabilities(
      input.capabilities,
      imports,
    );
    const metadata = this.normalizeMetadata(input.prompt, input.metadata);
    const id = this.normalizePlanId(input.id);
    const version = this.normalizePlanVersion(input.version);

    return {
      specVersion: resolveRuntimePlanSpecVersion(
        input.specVersion ?? DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      ),
      id,
      version,
      root,
      imports,
      ...(moduleManifest ? { moduleManifest } : {}),
      capabilities,
      ...(metadata ? { metadata } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(source ? { source } : {}),
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
    const moduleManifest =
      this.isRecord(parsed.moduleManifest) &&
      isRuntimeModuleManifest(parsed.moduleManifest)
        ? parsed.moduleManifest
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
    const importsFromManifest = moduleManifest
      ? Object.keys(moduleManifest)
      : undefined;
    const imports =
      importsFromPayload ??
      importsFromManifest ??
      (source ? this.parseImportsFromSource(source.code) : undefined);

    return this.createPlanFromRoot(root, {
      prompt,
      specVersion:
        typeof parsed.specVersion === "string" ? parsed.specVersion : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      version: typeof parsed.version === "number" ? parsed.version : undefined,
      imports,
      moduleManifest,
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

  private isLikelyCompleteJsonPayload(text: string): boolean {
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    const payload = codeBlockMatch ? codeBlockMatch[1] : text;
    const trimmed = payload.trim();

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return false;
    }

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (const char of trimmed) {
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const top = stack.pop();
        if (!top) {
          return false;
        }
        if ((char === "}" && top !== "{") || (char === "]" && top !== "[")) {
          return false;
        }
      }
    }

    return !inString && stack.length === 0;
  }

  private hasClosedCodeFence(text: string): boolean {
    const fences = text.match(/```/g);
    return Boolean(fences && fences.length >= 2 && fences.length % 2 === 0);
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

  private normalizeModuleManifest(
    manifest?: RuntimeModuleManifest,
  ): RuntimeModuleManifest | undefined {
    if (!manifest || Object.keys(manifest).length === 0) {
      return undefined;
    }

    return manifest;
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

  private createModuleManifestFromImports(
    imports: string[],
  ): RuntimeModuleManifest | undefined {
    if (imports.length === 0) {
      return undefined;
    }

    const manifest: RuntimeModuleManifest = {};
    for (const specifier of imports) {
      const resolvedUrl = this.resolveImportToUrl(specifier);
      const version = this.extractVersionFromSpecifier(specifier);
      manifest[specifier] = {
        resolvedUrl,
        ...(version ? { version } : {}),
        signer: "renderify-codegen",
      };
    }

    return manifest;
  }

  private resolveImportToUrl(specifier: string): string {
    if (this.isHttpUrl(specifier)) {
      return specifier;
    }

    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/")
    ) {
      return specifier;
    }

    if (specifier.startsWith("npm:")) {
      return this.resolveJspmSpecifier(specifier.slice(4));
    }

    return this.resolveJspmSpecifier(specifier);
  }

  private extractVersionFromSpecifier(specifier: string): string | undefined {
    if (!specifier.startsWith("npm:")) {
      return undefined;
    }

    const body = specifier.slice(4);
    const atIndex = body.lastIndexOf("@");
    if (atIndex <= 0) {
      return undefined;
    }

    const version = body.slice(atIndex + 1).trim();
    if (version.length === 0 || version.includes("/")) {
      return undefined;
    }

    return version;
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

    return this.normalizeSourceModule({
      language,
      code,
      exportName: "default",
    });
  }

  private createSourcePlan(
    prompt: string,
    source: RuntimeSourceModule,
  ): RuntimePlan {
    const imports = this.parseImportsFromSource(source.code);
    const normalizedSource = this.normalizeSourceModule(source);
    const sourceRuntime = normalizedSource?.runtime ?? "renderify";

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
          tags: ["source-module", source.language, `runtime:${sourceRuntime}`],
        },
        source: normalizedSource,
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

  private isHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private normalizeSourceModule(
    source?: RuntimeSourceModule,
  ): RuntimeSourceModule | undefined {
    if (!source) {
      return undefined;
    }

    const runtime =
      source.runtime ??
      this.inferSourceRuntimeFromLanguage(source.language, source.code);

    return {
      ...source,
      runtime,
    };
  }

  private inferSourceRuntimeFromLanguage(
    language: RuntimeSourceModule["language"],
    code: string,
  ): RuntimeSourceRuntime {
    if (language === "jsx" || language === "tsx") {
      return "preact";
    }

    if (
      (language === "js" || language === "ts") &&
      /from\s+["'](?:preact|react|recharts)["']/.test(code)
    ) {
      return "preact";
    }

    return "renderify";
  }

  private resolveJspmSpecifier(specifier: string): string {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      return "https://ga.jspm.io/npm:missing/index.js";
    }

    const override = JSPM_SPECIFIER_OVERRIDES[normalized];
    if (override) {
      return override;
    }

    const withEntry = this.withDefaultJspmEntry(normalized);
    return `https://ga.jspm.io/npm:${withEntry}`;
  }

  private withDefaultJspmEntry(specifier: string): string {
    if (/\.[mc]?js$/i.test(specifier)) {
      return specifier;
    }

    if (specifier.startsWith("@")) {
      const secondSlash = specifier.indexOf("/", 1);
      if (secondSlash === -1) {
        return `${specifier}/index.js`;
      }

      const subpathSlash = specifier.indexOf("/", secondSlash + 1);
      if (subpathSlash === -1) {
        return `${specifier}/index.js`;
      }

      return `${specifier}.js`;
    }

    if (!specifier.includes("/")) {
      return `${specifier}/index.js`;
    }

    return `${specifier}.js`;
  }
}
