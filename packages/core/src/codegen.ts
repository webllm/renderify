import {
  collectComponentModules,
  collectRuntimeSourceImports,
  createElementNode,
  createFnv1a64Hasher,
  createTextNode,
  DEFAULT_JSPM_SPECIFIER_OVERRIDES,
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

const INLINE_SOURCE_MODULE_ALIASES = new Set([
  "main",
  "app",
  "root",
  "default",
  "this-plan-source",
]);
const SYNTHETIC_SOURCE_MODULE_SPECIFIER_ALIASES = new Set(["this-plan-source"]);

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

export class DefaultCodeGenerator implements CodeGenerator {
  createIncrementalSession(
    input: IncrementalCodeGenerationInput,
  ): IncrementalCodeGenerationSession {
    let buffer = "";
    let lastSignature = "";

    const tryGenerate = async (): Promise<
      IncrementalCodeGenerationUpdate | undefined
    > => {
      const candidate = await this.tryBuildIncrementalCandidate(
        input.prompt,
        buffer,
      );
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

        return await tryGenerate();
      },
      finalize: async (finalText?: string) => {
        if (typeof finalText === "string" && finalText.length > 0) {
          buffer = finalText;
        }

        const candidate = await tryGenerate();
        return candidate?.plan;
      },
    };
  }

  async generatePlan(input: CodeGenerationInput): Promise<RuntimePlan> {
    const parsedPlan = await this.tryParseRuntimePlan(
      input.llmText,
      input.prompt,
    );
    if (parsedPlan) {
      return parsedPlan;
    }

    const source = this.tryExtractRuntimeSource(input.llmText);
    if (source) {
      return await this.createSourcePlan(input.prompt, source);
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

    return (
      plan.capabilities === undefined ||
      (typeof plan.capabilities === "object" && plan.capabilities !== null)
    );
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

  private async tryBuildIncrementalCandidate(
    prompt: string,
    llmText: string,
  ): Promise<IncrementalCodeGenerationUpdate | undefined> {
    const parsedPlan = await this.tryParseRuntimePlan(llmText, prompt);
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
        plan: await this.createSourcePlan(prompt, source),
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
    // Use a stable streaming hash to avoid allocating large JSON signatures.
    return this.hashIncrementalSignatureValue({
      root: plan.root,
      imports: plan.imports ?? [],
      source: plan.source,
      capabilities: plan.capabilities,
      state: plan.state,
    });
  }

  private hashIncrementalSignatureValue(value: unknown): string {
    // 64-bit FNV-1a is a deliberate performance trade-off for streaming updates:
    // collisions are possible (though rare), so this prioritizes low allocation
    // and speed over cryptographic uniqueness.
    const hasher = createFnv1a64Hasher();

    const update = (chunk: string): void => {
      hasher.update(chunk);
    };

    const visit = (input: unknown): void => {
      if (input === null) {
        update("null;");
        return;
      }
      if (input === undefined) {
        update("undefined;");
        return;
      }
      if (typeof input === "string") {
        update(`s:${input};`);
        return;
      }
      if (typeof input === "number") {
        update(Number.isFinite(input) ? `n:${String(input)};` : "n:null;");
        return;
      }
      if (typeof input === "boolean") {
        update(input ? "b:1;" : "b:0;");
        return;
      }
      if (Array.isArray(input)) {
        update("a:[");
        for (const entry of input) {
          visit(entry);
        }
        update("];");
        return;
      }
      if (typeof input === "object") {
        const entries = Object.entries(input as Record<string, unknown>)
          .filter(([, entryValue]) => entryValue !== undefined)
          .sort(([left], [right]) => left.localeCompare(right));
        update("o:{");
        for (const [key, entryValue] of entries) {
          update(`k:${key}=`);
          visit(entryValue);
        }
        update("};");
        return;
      }
      update(`x:${String(input)};`);
    };

    visit(value);
    return hasher.digestHex();
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
    const source = this.normalizeSourceModule(input.source);
    const imports = this.sanitizeSourceImportedSpecifiers(
      this.normalizeImports(input.imports) ?? collectComponentModules(root),
      source,
    );
    const moduleManifest = this.ensureModuleManifestCoverage(
      this.normalizeModuleManifest(input.moduleManifest, source),
      this.sanitizeSourceImportedSpecifiers(
        this.mergeImportedSpecifiers([
          ...imports,
          ...(input.capabilities?.allowedModules ?? []),
        ]),
        source,
      ),
    );
    const capabilities = this.normalizeCapabilities(
      input.capabilities,
      imports,
      source,
    );
    const metadata = this.normalizeMetadata(input.prompt, input.metadata);
    const id = this.normalizePlanId(input.id);
    const version = this.normalizePlanVersion(input.version);
    const specVersion = this.normalizePlanSpecVersion(input.specVersion);

    return {
      specVersion,
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

  private normalizePlanSpecVersion(specVersion?: string): string {
    const normalized = resolveRuntimePlanSpecVersion(
      specVersion ?? DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    );

    if (normalized.startsWith("runtime-plan/")) {
      return normalized;
    }

    return DEFAULT_RUNTIME_PLAN_SPEC_VERSION;
  }

  private rewriteRootForInlineSourceModuleReference(
    root: RuntimeNode,
    source: RuntimeSourceModule | undefined,
    prompt: string,
    moduleManifest: RuntimeModuleManifest | undefined,
  ): RuntimeNode {
    if (!source || root.type !== "component") {
      return root;
    }

    const moduleSpecifier = root.module.trim();
    if (moduleSpecifier.length === 0) {
      return root;
    }

    const normalizedSpecifier = moduleSpecifier.toLowerCase();
    const isLikelyInlineReference =
      normalizedSpecifier.startsWith("inline://") ||
      INLINE_SOURCE_MODULE_ALIASES.has(normalizedSpecifier);

    if (!isLikelyInlineReference && moduleManifest?.[moduleSpecifier]) {
      return root;
    }

    if (!isLikelyInlineReference) {
      return root;
    }

    return createElementNode(
      "section",
      { class: "renderify-runtime-source-plan" },
      [
        createElementNode("h2", undefined, [createTextNode(prompt)]),
        createElementNode("p", undefined, [
          createTextNode(`Runtime source module (${source.language}) prepared`),
        ]),
      ],
    );
  }

  private async tryParseRuntimePlan(
    text: string,
    prompt: string,
  ): Promise<RuntimePlan | undefined> {
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
    const capabilities: RuntimeCapabilities | undefined = isRuntimeCapabilities(
      parsed.capabilities,
    )
      ? parsed.capabilities
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
        ? this.normalizeSourceModule(parsed.source)
        : undefined;
    const normalizedRoot = this.rewriteRootForInlineSourceModuleReference(
      root,
      source,
      prompt,
      moduleManifest,
    );
    const importsFromPayload = Array.isArray(parsed.imports)
      ? (parsed.imports as unknown[])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const importsFromManifest = moduleManifest
      ? Object.keys(moduleManifest)
      : [];
    const importsFromSource = source
      ? await this.parseImportsFromSource(source.code)
      : [];
    const importsFromRoot = collectComponentModules(normalizedRoot);
    const importsFromCapabilities = capabilities?.allowedModules ?? [];
    const imports = this.mergeImportedSpecifiers([
      ...importsFromPayload,
      ...importsFromManifest,
      ...importsFromSource,
      ...importsFromRoot,
      ...importsFromCapabilities,
    ]);

    return this.createPlanFromRoot(normalizedRoot, {
      prompt,
      specVersion:
        typeof parsed.specVersion === "string" ? parsed.specVersion : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      version: typeof parsed.version === "number" ? parsed.version : undefined,
      imports: imports.length > 0 ? imports : undefined,
      moduleManifest,
      capabilities,
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

  private mergeImportedSpecifiers(values: string[]): string[] {
    const merged = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (normalized.length === 0) {
        continue;
      }
      merged.add(normalized);
    }

    return [...merged];
  }

  private normalizeModuleManifest(
    manifest?: RuntimeModuleManifest,
    source?: RuntimeSourceModule,
  ): RuntimeModuleManifest | undefined {
    if (!manifest || Object.keys(manifest).length === 0) {
      return undefined;
    }

    const nextEntries = Object.entries(manifest).filter(
      ([specifier]) =>
        !this.isSyntheticSourceModuleSpecifier(specifier, source),
    );
    if (nextEntries.length === 0) {
      return undefined;
    }

    return Object.fromEntries(nextEntries);
  }

  private ensureModuleManifestCoverage(
    manifest: RuntimeModuleManifest | undefined,
    imports: string[],
  ): RuntimeModuleManifest | undefined {
    const normalizedImports = this.mergeImportedSpecifiers(imports);
    if (normalizedImports.length === 0) {
      return manifest;
    }

    const generated = this.createModuleManifestFromImports(normalizedImports);
    if (!generated) {
      return manifest;
    }

    if (!manifest) {
      return generated;
    }

    return {
      ...generated,
      ...manifest,
    };
  }

  private normalizeCapabilities(
    capabilities: RuntimeCapabilities | undefined,
    imports: string[],
    source: RuntimeSourceModule | undefined,
  ): RuntimeCapabilities {
    const requestedModules = Array.isArray(capabilities?.allowedModules)
      ? this.sanitizeSourceImportedSpecifiers(
          capabilities.allowedModules,
          source,
        )
      : [];
    const allowedModules = this.mergeImportedSpecifiers([
      ...imports,
      ...requestedModules,
    ]);
    const normalized: RuntimeCapabilities = {
      domWrite: true,
      ...(capabilities ?? {}),
      allowedModules,
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
    const fencePattern = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)\s*```/g;
    let match: RegExpExecArray | null = fencePattern.exec(text);

    while (match) {
      const languageHint = match[1] ?? "";
      const code = match[2].trim();
      const language = this.normalizeRuntimeSourceLanguage(languageHint, code);

      if (language && code.length > 0) {
        return this.normalizeSourceModule({
          language,
          code,
          exportName: "default",
        });
      }

      match = fencePattern.exec(text);
    }

    return undefined;
  }

  private normalizeRuntimeSourceLanguage(
    languageHint: string,
    code: string,
  ): RuntimeSourceModule["language"] | undefined {
    const normalized = languageHint.trim().toLowerCase();

    if (normalized === "tsx" || normalized === "typescriptreact") {
      return "tsx";
    }

    if (normalized === "jsx" || normalized === "javascriptreact") {
      return "jsx";
    }

    if (normalized === "ts" || normalized === "typescript") {
      return this.isLikelyJsxCode(code) ? "tsx" : "ts";
    }

    if (normalized === "js" || normalized === "javascript") {
      return this.isLikelyJsxCode(code) ? "jsx" : "js";
    }

    return undefined;
  }

  private isLikelyJsxCode(code: string): boolean {
    return /<\s*[A-Za-z][A-Za-z0-9:_-]*[\s/>]/.test(code);
  }

  private async createSourcePlan(
    prompt: string,
    source: RuntimeSourceModule,
  ): Promise<RuntimePlan> {
    const normalizedSource = this.normalizeSourceModule(source);
    const imports = await this.parseImportsFromSource(
      normalizedSource?.code ?? source.code,
    );
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

  private async parseImportsFromSource(code: string): Promise<string[]> {
    return collectRuntimeSourceImports(code);
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

    const inferredRuntime = this.inferSourceRuntimeFromLanguage(
      source.language,
      source.code,
    );
    const runtime =
      source.runtime === "renderify" &&
      this.shouldPreferPreactSourceRuntime(source.language, source.code)
        ? "preact"
        : (source.runtime ?? inferredRuntime);
    const code =
      runtime === "preact"
        ? this.rewriteRenderifyImportsForPreactSource(source.code)
        : source.code;

    return {
      ...source,
      code,
      runtime,
    };
  }

  private sanitizeSourceImportedSpecifiers(
    specifiers: string[],
    source: RuntimeSourceModule | undefined,
  ): string[] {
    const sanitized: string[] = [];
    for (const specifier of specifiers) {
      if (this.isSyntheticSourceModuleSpecifier(specifier, source)) {
        continue;
      }
      sanitized.push(specifier);
    }
    return this.mergeImportedSpecifiers(sanitized);
  }

  private isSyntheticSourceModuleSpecifier(
    specifier: string,
    source: RuntimeSourceModule | undefined,
  ): boolean {
    if (!source) {
      return false;
    }

    const normalizedSpecifier = specifier.trim().toLowerCase();
    if (normalizedSpecifier.length === 0) {
      return false;
    }

    if (normalizedSpecifier.startsWith("inline://")) {
      return true;
    }

    if (SYNTHETIC_SOURCE_MODULE_SPECIFIER_ALIASES.has(normalizedSpecifier)) {
      return true;
    }

    if (normalizedSpecifier !== "renderify") {
      return false;
    }

    if (source.runtime !== "preact") {
      return false;
    }

    return !this.hasRenderifyImportSpecifier(source.code);
  }

  private shouldPreferPreactSourceRuntime(
    language: RuntimeSourceModule["language"],
    code: string,
  ): boolean {
    const jsxLikeLanguage = language === "jsx" || language === "tsx";
    if (!jsxLikeLanguage && language !== "js" && language !== "ts") {
      return false;
    }

    const reactLikeImports =
      /from\s+["'](?:react(?:\/jsx-(?:dev-)?runtime)?|react-dom(?:\/client)?|preact(?:\/(?:hooks|compat|jsx-runtime))?|renderify)["']/.test(
        code,
      );
    const hookCalls =
      /\buse(?:State|Effect|LayoutEffect|Memo|Callback|Ref|Reducer|Context|Id|Transition|DeferredValue|SyncExternalStore)\s*\(/.test(
        code,
      );

    return reactLikeImports || hookCalls;
  }

  private rewriteRenderifyImportsForPreactSource(code: string): string {
    return code
      .replace(/(\bfrom\s+["'])renderify(["'])/g, "$1preact/compat$2")
      .replace(/(\bimport\s+["'])renderify(["'])/g, "$1preact/compat$2")
      .replace(
        /(\bimport\s*\(\s*["'])renderify(["']\s*\))/g,
        "$1preact/compat$2",
      );
  }

  private hasRenderifyImportSpecifier(code: string): boolean {
    return (
      /(\bfrom\s+["'])renderify(["'])/.test(code) ||
      /(\bimport\s+["'])renderify(["'])/.test(code) ||
      /(\bimport\s*\(\s*["'])renderify(["']\s*\))/.test(code)
    );
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
      return "https://ga.jspm.io/npm:missing";
    }

    const override = DEFAULT_JSPM_SPECIFIER_OVERRIDES[normalized];
    if (override) {
      return override;
    }

    return `https://ga.jspm.io/npm:${normalized}`;
  }
}
