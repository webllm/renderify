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
  "source",
  "this-plan-source",
]);
const SYNTHETIC_SOURCE_MODULE_SPECIFIER_ALIASES = new Set([
  "source",
  "this-plan-source",
]);
const SHADCN_ALIAS_IMPORT_PREFIX = "https://esm.sh/@/components/ui/";
const MUI_MATERIAL_BARE_SPECIFIER = "@mui/material";
const MUI_ICONS_BARE_PREFIX = "@mui/icons-material";
const JSX_INTRINSIC_TAG_NAMES = [
  "a",
  "article",
  "aside",
  "button",
  "code",
  "details",
  "dialog",
  "div",
  "em",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "option",
  "p",
  "pre",
  "progress",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "thead",
  "tr",
  "ul",
];

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
      return await this.stabilizePlanForPrompt(parsedPlan, input.prompt);
    }

    const source = this.tryExtractRuntimeSource(input.llmText);
    if (source) {
      const sourcePlan = await this.createSourcePlan(input.prompt, source);
      return await this.stabilizePlanForPrompt(sourcePlan, input.prompt);
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
    syntheticSourceSpecifiers?: Set<string>,
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
      INLINE_SOURCE_MODULE_ALIASES.has(normalizedSpecifier) ||
      Boolean(
        syntheticSourceSpecifiers?.has(normalizedSpecifier) &&
          !this.isHttpUrl(moduleSpecifier) &&
          !this.isPathLikeModuleSpecifier(moduleSpecifier),
      );

    if (!isLikelyInlineReference) {
      if (moduleManifest?.[moduleSpecifier]) {
        return root;
      }
      return root;
    }

    return this.createSourcePreparedRoot(prompt, source.language);
  }

  private async tryParseRuntimePlan(
    text: string,
    prompt: string,
  ): Promise<RuntimePlan | undefined> {
    const parsed = this.tryParseJsonPayload(text);
    if (!this.isRecord(parsed)) {
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
    const parsedRoot = parsed.root;
    const root = isRuntimeNode(parsedRoot)
      ? parsedRoot
      : source
        ? this.createSourcePreparedRoot(prompt, source.language)
        : undefined;
    if (!root) {
      return undefined;
    }
    const syntheticSourceSpecifiers = this.collectSyntheticSourceSpecifiers(
      root,
      source,
    );
    const sanitizedModuleManifest = this.normalizeModuleManifest(
      moduleManifest,
      source,
      syntheticSourceSpecifiers,
    );
    const normalizedRoot = this.rewriteRootForInlineSourceModuleReference(
      root,
      source,
      prompt,
      sanitizedModuleManifest,
      syntheticSourceSpecifiers,
    );
    const sanitizeImported = (specifiers: string[]): string[] =>
      this.sanitizeSourceImportedSpecifiers(
        specifiers,
        source,
        syntheticSourceSpecifiers,
      );
    const importsFromPayloadRaw = Array.isArray(parsed.imports)
      ? (parsed.imports as unknown[])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const importsFromPayload = sanitizeImported(importsFromPayloadRaw);
    const importsFromManifest = sanitizedModuleManifest
      ? Object.keys(sanitizedModuleManifest)
      : [];
    const importsFromSource = source
      ? await this.parseImportsFromSource(source.code)
      : [];
    const importsFromRoot = collectComponentModules(normalizedRoot);
    const importsFromCapabilities = sanitizeImported(
      capabilities?.allowedModules ?? [],
    );
    const normalizedCapabilities = capabilities
      ? {
          ...capabilities,
          allowedModules: importsFromCapabilities,
        }
      : undefined;
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
      moduleManifest: sanitizedModuleManifest,
      capabilities: normalizedCapabilities,
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
    const candidates: string[] = [];

    const jsonCodeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonCodeBlockMatch?.[1]) {
      candidates.push(jsonCodeBlockMatch[1]);
    }

    const fencedCodeBlocks = text.matchAll(
      /```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```/g,
    );
    for (const match of fencedCodeBlocks) {
      if (typeof match[1] === "string" && match[1].trim().length > 0) {
        candidates.push(match[1]);
      }
    }

    candidates.push(text);

    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        continue;
      }

      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          // fall through to balanced extraction path
        }
      }

      const extracted = this.extractFirstJsonPayload(trimmed);
      if (!extracted) {
        continue;
      }

      try {
        return JSON.parse(extracted) as unknown;
      } catch {
        // ignore and continue
      }
    }

    return undefined;
  }

  private extractFirstJsonPayload(text: string): string | undefined {
    let inString = false;
    let escaped = false;
    let startIndex = -1;
    const stack: string[] = [];

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

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
        if (startIndex >= 0) {
          inString = true;
        }
        continue;
      }

      if (startIndex < 0) {
        if (char === "{") {
          startIndex = index;
          stack.push("}");
        } else if (char === "[") {
          startIndex = index;
          stack.push("]");
        }
        continue;
      }

      if (char === "{") {
        stack.push("}");
        continue;
      }

      if (char === "[") {
        stack.push("]");
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = stack.pop();
        if (expected !== char) {
          return undefined;
        }
        if (stack.length === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return undefined;
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
    syntheticSourceSpecifiers?: Set<string>,
  ): RuntimeModuleManifest | undefined {
    if (!manifest || Object.keys(manifest).length === 0) {
      return undefined;
    }

    const nextManifest: RuntimeModuleManifest = {};
    for (const [rawSpecifier, descriptor] of Object.entries(manifest)) {
      const specifier = this.normalizeImportSpecifier(rawSpecifier);
      if (!specifier) {
        continue;
      }
      if (
        this.isSyntheticSourceModuleSpecifier(
          specifier,
          source,
          syntheticSourceSpecifiers,
        )
      ) {
        continue;
      }

      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        typeof descriptor.resolvedUrl !== "string"
      ) {
        continue;
      }

      const resolvedUrl = this.normalizeImportSpecifier(descriptor.resolvedUrl);
      if (!resolvedUrl) {
        continue;
      }

      nextManifest[specifier] = {
        ...descriptor,
        resolvedUrl,
      };
    }

    if (Object.keys(nextManifest).length === 0) {
      return undefined;
    }

    return nextManifest;
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
      this.createSourcePreparedRoot(prompt, source.language),
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

  private async stabilizePlanForPrompt(
    plan: RuntimePlan,
    prompt: string,
  ): Promise<RuntimePlan> {
    const source = plan.source;
    if (!source) {
      const recoveredPlan = await this.recoverMissingSyntheticSourcePlan(
        plan,
        prompt,
      );
      return recoveredPlan ?? plan;
    }

    const unsupportedImports = await this.collectUnsupportedSourceImports(
      source.code,
    );
    if (unsupportedImports.length > 0 && this.shouldUseTodoFallback(prompt)) {
      return await this.createTodoFallbackPlan(plan, prompt);
    }

    const syntaxValid = await this.isSourceSyntaxValid(source);
    if (syntaxValid) {
      return plan;
    }

    if (!this.shouldUseTodoFallback(prompt)) {
      return plan;
    }

    return await this.createTodoFallbackPlan(plan, prompt);
  }

  private async recoverMissingSyntheticSourcePlan(
    plan: RuntimePlan,
    prompt: string,
  ): Promise<RuntimePlan | undefined> {
    if (!this.isMissingSyntheticSourcePlan(plan)) {
      return undefined;
    }

    if (this.shouldUseTodoFallback(prompt)) {
      return await this.createTodoFallbackPlan(plan, prompt);
    }

    const fallbackRoot = this.createFallbackRoot(
      prompt,
      "Model output referenced an inline source module alias without source code.",
    );
    const fallbackImports = collectComponentModules(fallbackRoot);
    const fallbackCapabilities = plan.capabilities
      ? {
          ...plan.capabilities,
          domWrite: true,
          allowedModules: fallbackImports,
        }
      : {
          domWrite: true,
          allowedModules: fallbackImports,
        };
    const fallbackMetadata = plan.metadata
      ? {
          ...plan.metadata,
          sourceFallback: "missing-source-module",
        }
      : {
          sourceFallback: "missing-source-module",
        };

    return this.createPlanFromRoot(fallbackRoot, {
      prompt,
      id: plan.id,
      version: plan.version,
      specVersion: plan.specVersion,
      metadata: fallbackMetadata,
      state: plan.state,
      imports: fallbackImports,
      capabilities: fallbackCapabilities,
    });
  }

  private isMissingSyntheticSourcePlan(plan: RuntimePlan): boolean {
    if (plan.source || plan.root.type !== "component") {
      return false;
    }

    const normalizedModule = plan.root.module.trim().toLowerCase();
    if (normalizedModule.length === 0) {
      return false;
    }

    return (
      normalizedModule.startsWith("inline://") ||
      INLINE_SOURCE_MODULE_ALIASES.has(normalizedModule) ||
      SYNTHETIC_SOURCE_MODULE_SPECIFIER_ALIASES.has(normalizedModule)
    );
  }

  private async createTodoFallbackPlan(
    plan: RuntimePlan,
    prompt: string,
  ): Promise<RuntimePlan> {
    const fallbackSource = this.createTodoTemplateSourceModule();
    const fallbackImports = await this.parseImportsFromSource(
      fallbackSource.code,
    );
    const fallbackCapabilities = plan.capabilities
      ? {
          ...plan.capabilities,
          domWrite: true,
          allowedModules: [],
        }
      : {
          domWrite: true,
          allowedModules: [],
        };
    const fallbackMetadata = plan.metadata
      ? {
          ...plan.metadata,
          sourceFallback: "todo-template",
        }
      : {
          sourceFallback: "todo-template",
        };

    return this.createPlanFromRoot(
      this.createSourcePreparedRoot(prompt, fallbackSource.language),
      {
        prompt,
        id: plan.id,
        version: plan.version,
        specVersion: plan.specVersion,
        metadata: fallbackMetadata,
        state: plan.state,
        imports: fallbackImports,
        capabilities: fallbackCapabilities,
        source: fallbackSource,
      },
    );
  }

  private async parseImportsFromSource(code: string): Promise<string[]> {
    return collectRuntimeSourceImports(code);
  }

  private shouldUseTodoFallback(prompt: string): boolean {
    return /\btodo\b/i.test(prompt);
  }

  private createTodoTemplateSourceModule(): RuntimeSourceModule {
    const code = [
      'import { useMemo, useState } from "preact/hooks";',
      "type TodoItem = { id: number; text: string; done: boolean };",
      "export default function TodoApp() {",
      "  const [todos, setTodos] = useState<TodoItem[]>([]);",
      '  const [draft, setDraft] = useState("");',
      "  const remaining = useMemo(() => todos.filter((todo) => !todo.done).length, [todos]);",
      "  const addTodo = () => {",
      "    const text = draft.trim();",
      "    if (!text) {",
      "      return;",
      "    }",
      "    setTodos((current) => [...current, { id: Date.now(), text, done: false }]);",
      '    setDraft("");',
      "  };",
      "  const toggleTodo = (id: number) => {",
      "    setTodos((current) =>",
      "      current.map((todo) =>",
      "        todo.id === id ? { ...todo, done: !todo.done } : todo,",
      "      ),",
      "    );",
      "  };",
      "  const removeTodo = (id: number) => {",
      "    setTodos((current) => current.filter((todo) => todo.id !== id));",
      "  };",
      "  return (",
      "    <div>",
      "      <h1>Todo App</h1>",
      "      <p>{remaining} item(s) remaining</p>",
      "      <input",
      '        type="text"',
      "        value={draft}",
      "        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}",
      "        onKeyDown={(event) => {",
      '          if (event.key === "Enter") {',
      "            addTodo();",
      "          }",
      "        }}",
      '        placeholder="Add a todo"',
      "      />",
      "      <button onClick={addTodo}>Add Todo</button>",
      "      <ul>",
      "        {todos.map((todo) => (",
      "          <li key={todo.id}>",
      "            <input",
      '              type="checkbox"',
      "              checked={todo.done}",
      "              onInput={() => toggleTodo(todo.id)}",
      "            />",
      '            <span style={{ textDecoration: todo.done ? "line-through" : "none" }}>',
      "              {todo.text}",
      "            </span>",
      "            <button onClick={() => removeTodo(todo.id)}>Delete</button>",
      "          </li>",
      "        ))}",
      "      </ul>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    return {
      language: "tsx",
      runtime: "preact",
      exportName: "default",
      code,
    };
  }

  private async isSourceSyntaxValid(
    source: RuntimeSourceModule,
  ): Promise<boolean> {
    if (!this.isLikelyNodeRuntime()) {
      return true;
    }

    try {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier)",
      ) as (specifier: string) => Promise<{
        transform?: (
          code: string,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
        default?: {
          transform?: (
            code: string,
            options: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }>;
      const esbuildModule = await dynamicImport("esbuild");
      const transform =
        esbuildModule.transform ?? esbuildModule.default?.transform;
      if (typeof transform !== "function") {
        return true;
      }

      const transformOptions: Record<string, unknown> = {
        loader: source.language,
        format: "esm",
        target: "es2020",
      };
      if (source.language === "jsx" || source.language === "tsx") {
        transformOptions.jsx = "automatic";
        if (source.runtime === "preact") {
          transformOptions.jsxImportSource = "preact";
        }
      }

      await transform(source.code, transformOptions);
      return true;
    } catch {
      return false;
    }
  }

  private isLikelyNodeRuntime(): boolean {
    return (
      typeof process !== "undefined" &&
      typeof process.versions === "object" &&
      typeof process.versions?.node === "string"
    );
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
    const runtimeAdaptedCode =
      runtime === "preact"
        ? this.rewriteRenderifyImportsForPreactSource(source.code)
        : source.code;
    const shadcnPortableCode =
      runtime === "preact"
        ? this.rewritePortableShadcnSourceImports(runtimeAdaptedCode)
        : runtimeAdaptedCode;
    const portableCode =
      runtime === "preact"
        ? this.rewritePortableMaterialUiSourceImports(shadcnPortableCode)
        : shadcnPortableCode;
    const code = this.repairCompactJsxAttributeSpacing(
      portableCode,
      source.language,
    );
    const balancedCode = this.stripUnmatchedClosingBraces(code);
    const exportReadyCode = this.ensureSourceExportAvailability(balancedCode);

    return {
      ...source,
      code: exportReadyCode,
      exportName: this.normalizeSourceExportName(
        source.exportName,
        exportReadyCode,
      ),
      runtime,
    };
  }

  private createSourcePreparedRoot(
    prompt: string,
    language: RuntimeSourceModule["language"],
  ): RuntimeNode {
    return createElementNode(
      "section",
      { class: "renderify-runtime-source-plan" },
      [
        createElementNode("h2", undefined, [createTextNode(prompt)]),
        createElementNode("p", undefined, [
          createTextNode(`Runtime source module (${language}) prepared`),
        ]),
      ],
    );
  }

  private repairCompactJsxAttributeSpacing(
    code: string,
    language: RuntimeSourceModule["language"],
  ): string {
    if (language !== "jsx" && language !== "tsx") {
      return code;
    }

    const intrinsicTagGroup = JSX_INTRINSIC_TAG_NAMES.join("|");
    const compactTagPattern = new RegExp(
      `<(${intrinsicTagGroup})([A-Za-z_:$][A-Za-z0-9_:$.-]*=)`,
      "g",
    );
    const compactSpreadPattern = new RegExp(
      `<(${intrinsicTagGroup})(\\{\\.\\.\\.)`,
      "g",
    );

    let repaired = code;
    repaired = repaired.replace(compactTagPattern, "<$1 $2");
    repaired = repaired.replace(compactSpreadPattern, "<$1 $2");
    repaired = repaired.replace(
      /(["'}])(?=[A-Za-z_:$][A-Za-z0-9_:$.-]*=)/g,
      "$1 ",
    );
    repaired = repaired.replace(/(["'}])(?=\{\.\.\.)/g, "$1 ");

    return repaired;
  }

  private normalizeSourceExportName(
    exportName: string | undefined,
    code: string,
  ): string {
    const normalizedExportName =
      typeof exportName === "string" ? exportName.trim() : "";
    const hasDefaultExport = /\bexport\s+default\b/.test(code);
    const namedExports = this.collectNamedSourceExports(code);

    if (normalizedExportName.length > 0) {
      if (
        normalizedExportName === "default" ||
        namedExports.has(normalizedExportName)
      ) {
        return normalizedExportName;
      }

      if (hasDefaultExport) {
        return "default";
      }

      if (namedExports.size === 1) {
        return [...namedExports][0];
      }

      return normalizedExportName;
    }

    if (hasDefaultExport) {
      return "default";
    }

    if (namedExports.size === 1) {
      return [...namedExports][0];
    }

    return "default";
  }

  private collectNamedSourceExports(code: string): Set<string> {
    const names = new Set<string>();
    const declarationPatterns = [
      /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g,
      /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)\b/g,
    ];
    for (const pattern of declarationPatterns) {
      let match = pattern.exec(code);
      while (match) {
        names.add(match[1]);
        match = pattern.exec(code);
      }
    }

    const exportListPattern = /\bexport\s*\{([^}]+)\}/g;
    let exportListMatch = exportListPattern.exec(code);
    while (exportListMatch) {
      const specifiers = exportListMatch[1].split(",");
      for (const specifier of specifiers) {
        const trimmed = specifier.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const aliasMatch = /\bas\s+([A-Za-z_$][\w$]*)$/i.exec(trimmed);
        if (aliasMatch?.[1]) {
          names.add(aliasMatch[1]);
          continue;
        }

        const identifierMatch = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
        if (identifierMatch?.[1]) {
          names.add(identifierMatch[1]);
        }
      }

      exportListMatch = exportListPattern.exec(code);
    }

    return names;
  }

  private ensureSourceExportAvailability(code: string): string {
    if (/\bexport\s+default\b/.test(code)) {
      return code;
    }

    if (this.collectNamedSourceExports(code).size > 0) {
      return code;
    }

    const inferredComponent = this.inferLikelySourceComponentIdentifier(code);
    if (!inferredComponent) {
      return code;
    }

    return `${code}\nexport default ${inferredComponent};`;
  }

  private inferLikelySourceComponentIdentifier(
    code: string,
  ): string | undefined {
    const patterns = [
      /\b(?:async\s+)?function\s+([A-Z][\w$]*)\s*\(/g,
      /\b(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /\bclass\s+([A-Z][\w$]*)\s+/g,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(code);
      if (match?.[1]) {
        return match[1];
      }
    }

    return undefined;
  }

  private stripUnmatchedClosingBraces(code: string): string {
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;
    let result = "";

    for (let index = 0; index < code.length; index += 1) {
      const char = code[index];
      const next = index + 1 < code.length ? code[index + 1] : "";

      if (inLineComment) {
        result += char;
        if (char === "\n") {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        result += char;
        if (char === "*" && next === "/") {
          result += next;
          index += 1;
          inBlockComment = false;
        }
        continue;
      }

      if (inSingleQuote || inDoubleQuote || inTemplateString) {
        result += char;
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (inSingleQuote && char === "'") {
          inSingleQuote = false;
          continue;
        }
        if (inDoubleQuote && char === '"') {
          inDoubleQuote = false;
          continue;
        }
        if (inTemplateString && char === "`") {
          inTemplateString = false;
        }
        continue;
      }

      if (char === "/" && next === "/") {
        result += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        result += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }

      if (char === "'") {
        result += char;
        inSingleQuote = true;
        continue;
      }
      if (char === '"') {
        result += char;
        inDoubleQuote = true;
        continue;
      }
      if (char === "`") {
        result += char;
        inTemplateString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        result += char;
        continue;
      }

      if (char === "}") {
        if (depth === 0) {
          continue;
        }
        depth -= 1;
        result += char;
        continue;
      }

      result += char;
    }

    return result;
  }

  private sanitizeSourceImportedSpecifiers(
    specifiers: string[],
    source: RuntimeSourceModule | undefined,
    syntheticSourceSpecifiers?: Set<string>,
  ): string[] {
    const sanitized: string[] = [];
    for (const specifier of specifiers) {
      const normalizedSpecifier = this.normalizeImportSpecifier(specifier);
      if (!normalizedSpecifier) {
        continue;
      }
      if (
        this.isSyntheticSourceModuleSpecifier(
          normalizedSpecifier,
          source,
          syntheticSourceSpecifiers,
        )
      ) {
        continue;
      }
      sanitized.push(normalizedSpecifier);
    }
    return this.mergeImportedSpecifiers(sanitized);
  }

  private normalizeImportSpecifier(specifier: string): string | undefined {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      return undefined;
    }

    if (this.isUnsupportedImportSpecifier(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private isUnsupportedImportSpecifier(specifier: string): boolean {
    if (specifier.includes("*")) {
      return true;
    }

    const normalizedLower = specifier.trim().toLowerCase();
    if (
      normalizedLower === MUI_MATERIAL_BARE_SPECIFIER ||
      normalizedLower.startsWith(`${MUI_ICONS_BARE_PREFIX}/`)
    ) {
      return true;
    }

    if (!specifier.startsWith("http://") && !specifier.startsWith("https://")) {
      return false;
    }

    if (!this.isHttpUrl(specifier)) {
      return true;
    }

    try {
      const parsed = new URL(specifier);
      const pathname = parsed.pathname.toLowerCase();
      return (
        pathname.includes("/@/") ||
        pathname.startsWith("/@mui/material") ||
        pathname.startsWith("/@mui/icons-material")
      );
    } catch {
      return true;
    }
  }

  private async collectUnsupportedSourceImports(
    code: string,
  ): Promise<string[]> {
    const imports = await this.parseImportsFromSource(code);
    const unsupported: string[] = [];

    for (const specifier of imports) {
      if (this.isUnsupportedImportSpecifier(specifier)) {
        unsupported.push(specifier);
      }
    }

    return this.mergeImportedSpecifiers(unsupported);
  }

  private rewritePortableShadcnSourceImports(code: string): string {
    const shadcnImportPattern =
      /^\s*import\s+(type\s+)?([^;]+?)\s+from\s+["'](https?:\/\/esm\.sh\/@\/components\/ui\/[^"']+)["'];\s*$/gm;
    let rewroteImport = false;

    const rewrittenImports = code.replace(
      shadcnImportPattern,
      (
        _match: string,
        typeKeyword: string | undefined,
        clauseRaw: string,
        specifier: string,
      ) => {
        rewroteImport = true;
        if (typeof typeKeyword === "string" && typeKeyword.trim().length > 0) {
          return "";
        }

        return this.buildPortableShadcnImportBinding(clauseRaw, specifier);
      },
    );

    if (!rewroteImport) {
      return code;
    }

    const wildcardImportPattern =
      /^\s*import\s+[^;]+?\s+from\s+["'][^"']*\*[^"']*["'];\s*$/gm;
    const withoutWildcardImports = rewrittenImports.replace(
      wildcardImportPattern,
      "",
    );

    return `${this.createPortableShadcnComponentShim()}\n${withoutWildcardImports.trimStart()}`;
  }

  private buildPortableShadcnImportBinding(
    clauseRaw: string,
    specifier: string,
  ): string {
    const clause = clauseRaw.replace(/\s+/g, " ").trim();
    if (clause.length === 0) {
      return "";
    }

    if (clause.startsWith("{") && clause.endsWith("}")) {
      const normalizedNamedClause = clause.replace(/\btype\s+/g, "");
      return `const ${normalizedNamedClause} = __renderifyShadcnCompat;`;
    }

    if (clause.startsWith("* as ")) {
      const namespaceName = clause.slice("* as ".length).trim();
      if (!namespaceName) {
        return "";
      }
      return `const ${namespaceName} = __renderifyShadcnCompat;`;
    }

    const splitIndex = clause.indexOf(",");
    if (splitIndex > 0) {
      const defaultImport = clause.slice(0, splitIndex).trim();
      const namedImport = clause.slice(splitIndex + 1).trim();
      const statements: string[] = [];

      if (defaultImport.length > 0) {
        const defaultBinding = this.resolveShadcnDefaultBindingName(specifier);
        statements.push(
          `const ${defaultImport} = __renderifyShadcnCompat.${defaultBinding};`,
        );
      }

      if (namedImport.startsWith("{") && namedImport.endsWith("}")) {
        statements.push(
          `const ${namedImport.replace(/\btype\s+/g, "")} = __renderifyShadcnCompat;`,
        );
      }

      return statements.join("\n");
    }

    const defaultBinding = this.resolveShadcnDefaultBindingName(specifier);
    return `const ${clause} = __renderifyShadcnCompat.${defaultBinding};`;
  }

  private resolveShadcnDefaultBindingName(specifier: string): string {
    if (!specifier.startsWith(SHADCN_ALIAS_IMPORT_PREFIX)) {
      return "Card";
    }

    const tail = specifier.slice(SHADCN_ALIAS_IMPORT_PREFIX.length);
    const segment = tail.split("/").filter((part) => part.length > 0)[0];
    const normalized = this.toPascalCaseIdentifier(segment);
    return normalized.length > 0 ? normalized : "Card";
  }

  private toPascalCaseIdentifier(value: string | undefined): string {
    const input = typeof value === "string" ? value.trim() : "";
    if (input.length === 0) {
      return "";
    }

    return input
      .split(/[^A-Za-z0-9]+/)
      .filter((entry) => entry.length > 0)
      .map((entry) => entry[0].toUpperCase() + entry.slice(1))
      .join("");
  }

  private createPortableShadcnComponentShim(): string {
    return [
      "const __renderifyShadcnCompat = (() => {",
      "  const Button = (props) => {",
      "    const { children, type, ...rest } = props ?? {};",
      '    return <button type={type ?? "button"} {...rest}>{children}</button>;',
      "  };",
      "  const Input = (props) => <input {...(props ?? {})} />;",
      "  const Checkbox = (props) => {",
      "    const { checked, onCheckedChange, onInput, ...rest } = props ?? {};",
      "    return (",
      '      <input type="checkbox" {...rest} checked={Boolean(checked)} onInput={(event) => {',
      '        if (typeof onInput === "function") {',
      "          onInput(event);",
      "        }",
      '        if (typeof onCheckedChange === "function") {',
      "          const target = event && typeof event === 'object' ? event.target : undefined;",
      "          const nextChecked =",
      "            target && typeof target === 'object' && 'checked' in target",
      "              ? Boolean(target.checked)",
      "              : Boolean(!checked);",
      "          onCheckedChange(nextChecked);",
      "        }",
      "      }} />",
      "    );",
      "  };",
      "  const Card = (props) => <div {...(props ?? {})}>{props?.children}</div>;",
      "  const CardHeader = (props) => <div {...(props ?? {})}>{props?.children}</div>;",
      "  const CardContent = (props) => <div {...(props ?? {})}>{props?.children}</div>;",
      "  const CardTitle = (props) => <h3 {...(props ?? {})}>{props?.children}</h3>;",
      "  const CardDescription = (props) => <p {...(props ?? {})}>{props?.children}</p>;",
      "  return {",
      "    Button,",
      "    Input,",
      "    Checkbox,",
      "    Card,",
      "    CardHeader,",
      "    CardContent,",
      "    CardTitle,",
      "    CardDescription,",
      "  };",
      "})();",
    ].join("\n");
  }

  private rewritePortableMaterialUiSourceImports(code: string): string {
    const materialImportPattern =
      /^\s*import\s+(type\s+)?([^;]+?)\s+from\s+["'](@mui\/material|https?:\/\/esm\.sh\/@mui\/material[^"']*)["'];\s*$/gm;
    const iconImportPattern =
      /^\s*import\s+(type\s+)?([^;]+?)\s+from\s+["'](@mui\/icons-material\/[^"']+|https?:\/\/esm\.sh\/@mui\/icons-material\/[^"']+)["'];\s*$/gm;
    let rewroteImport = false;

    const rewrittenMaterialImports = code.replace(
      materialImportPattern,
      (_match: string, typeKeyword: string | undefined, clauseRaw: string) => {
        rewroteImport = true;
        if (typeof typeKeyword === "string" && typeKeyword.trim().length > 0) {
          return "";
        }

        return this.buildPortableMaterialImportBinding(clauseRaw);
      },
    );

    const rewrittenImports = rewrittenMaterialImports.replace(
      iconImportPattern,
      (
        _match: string,
        typeKeyword: string | undefined,
        clauseRaw: string,
        specifier: string,
      ) => {
        rewroteImport = true;
        if (typeof typeKeyword === "string" && typeKeyword.trim().length > 0) {
          return "";
        }

        return this.buildPortableMaterialIconImportBinding(
          clauseRaw,
          specifier,
        );
      },
    );

    if (!rewroteImport) {
      return code;
    }

    return `${this.createPortableMaterialUiShim()}\n${rewrittenImports.trimStart()}`;
  }

  private buildPortableMaterialImportBinding(clauseRaw: string): string {
    const clause = clauseRaw.replace(/\s+/g, " ").trim();
    if (clause.length === 0) {
      return "";
    }

    if (clause.startsWith("{") && clause.endsWith("}")) {
      const normalizedNamedClause = clause.replace(/\btype\s+/g, "");
      return `const ${normalizedNamedClause} = __renderifyMuiCompat;`;
    }

    if (clause.startsWith("* as ")) {
      const namespaceName = clause.slice("* as ".length).trim();
      if (!namespaceName) {
        return "";
      }
      return `const ${namespaceName} = __renderifyMuiCompat;`;
    }

    const splitIndex = clause.indexOf(",");
    if (splitIndex > 0) {
      const defaultImport = clause.slice(0, splitIndex).trim();
      const namedImport = clause.slice(splitIndex + 1).trim();
      const statements: string[] = [];

      if (defaultImport.length > 0) {
        statements.push(`const ${defaultImport} = __renderifyMuiCompat;`);
      }

      if (namedImport.startsWith("{") && namedImport.endsWith("}")) {
        statements.push(
          `const ${namedImport.replace(/\btype\s+/g, "")} = __renderifyMuiCompat;`,
        );
      }

      return statements.join("\n");
    }

    return `const ${clause} = __renderifyMuiCompat;`;
  }

  private buildPortableMaterialIconImportBinding(
    clauseRaw: string,
    specifier: string,
  ): string {
    const clause = clauseRaw.replace(/\s+/g, " ").trim();
    if (clause.length === 0) {
      return "";
    }

    const iconName = this.resolvePortableMaterialIconName(specifier);

    if (clause.startsWith("{") && clause.endsWith("}")) {
      const normalizedNamedClause = clause.replace(/\btype\s+/g, "");
      return `const ${normalizedNamedClause} = __renderifyMuiIcons;`;
    }

    if (clause.startsWith("* as ")) {
      const namespaceName = clause.slice("* as ".length).trim();
      if (!namespaceName) {
        return "";
      }
      return `const ${namespaceName} = __renderifyMuiIcons;`;
    }

    const splitIndex = clause.indexOf(",");
    if (splitIndex > 0) {
      const defaultImport = clause.slice(0, splitIndex).trim();
      const namedImport = clause.slice(splitIndex + 1).trim();
      const statements: string[] = [];

      if (defaultImport.length > 0) {
        statements.push(
          `const ${defaultImport} = __renderifyMuiIcons.${iconName};`,
        );
      }

      if (namedImport.startsWith("{") && namedImport.endsWith("}")) {
        statements.push(
          `const ${namedImport.replace(/\btype\s+/g, "")} = __renderifyMuiIcons;`,
        );
      }

      return statements.join("\n");
    }

    return `const ${clause} = __renderifyMuiIcons.${iconName};`;
  }

  private resolvePortableMaterialIconName(specifier: string): string {
    const normalized = specifier.trim();
    if (normalized.length === 0) {
      return "Dot";
    }

    const lastPathSegment = normalized.split("/").filter(Boolean).pop();
    if (!lastPathSegment) {
      return "Dot";
    }

    const cleaned = lastPathSegment.split("?")[0].split("#")[0].trim();
    const iconName = this.toPascalCaseIdentifier(cleaned);
    return iconName.length > 0 ? iconName : "Dot";
  }

  private createPortableMaterialUiShim(): string {
    return [
      "const __renderifyMuiCompat = (() => {",
      "  const toPx = (value) => {",
      "    if (value === undefined || value === null) {",
      "      return undefined;",
      "    }",
      "    if (typeof value === 'number' && Number.isFinite(value)) {",
      "      return String(value * 8) + 'px';",
      "    }",
      "    return String(value);",
      "  };",
      "  const mergeStyle = (...candidates) => {",
      "    const merged = {};",
      "    for (const candidate of candidates) {",
      "      if (candidate && typeof candidate === 'object') {",
      "        Object.assign(merged, candidate);",
      "      }",
      "    }",
      "    return merged;",
      "  };",
      "  const Box = (props) => {",
      "    const { children, display, gap, marginBottom, marginTop, margin, style, ...rest } = props ?? {};",
      "    return (",
      "      <div",
      "        {...rest}",
      "        style={mergeStyle(style, {",
      "          ...(display !== undefined ? { display } : {}),",
      "          ...(gap !== undefined ? { gap: toPx(gap) } : {}),",
      "          ...(marginBottom !== undefined ? { marginBottom: toPx(marginBottom) } : {}),",
      "          ...(marginTop !== undefined ? { marginTop: toPx(marginTop) } : {}),",
      "          ...(margin !== undefined ? { margin: toPx(margin) } : {}),",
      "        })}",
      "      >",
      "        {children}",
      "      </div>",
      "    );",
      "  };",
      "  const Container = (props) => {",
      "    const { children, maxWidth, style, ...rest } = props ?? {};",
      "    const maxWidthMap = { xs: 480, sm: 640, md: 768, lg: 1024, xl: 1280 };",
      "    const resolvedMaxWidth = typeof maxWidth === 'string' ? maxWidthMap[maxWidth] : undefined;",
      "    return (",
      "      <div",
      "        {...rest}",
      "        style={mergeStyle(",
      "          { margin: '0 auto', width: '100%' },",
      "          resolvedMaxWidth ? { maxWidth: String(resolvedMaxWidth) + 'px' } : {},",
      "          style,",
      "        )}",
      "      >",
      "        {children}",
      "      </div>",
      "    );",
      "  };",
      "  const Paper = (props) => {",
      "    const { children, elevation, style, ...rest } = props ?? {};",
      "    const shadow = typeof elevation === 'number' && elevation > 0",
      "      ? '0 ' + String(Math.min(24, elevation * 2)) + 'px ' + String(Math.min(48, elevation * 4)) + 'px rgba(0,0,0,0.12)'",
      "      : 'none';",
      "    return (",
      "      <div",
      "        {...rest}",
      "        style={mergeStyle(",
      "          { border: '1px solid #e5e7eb', borderRadius: '12px', background: '#fff', boxShadow: shadow },",
      "          style,",
      "        )}",
      "      >",
      "        {children}",
      "      </div>",
      "    );",
      "  };",
      "  const Typography = (props) => {",
      "    const { children, variant, component, align, color, style, ...rest } = props ?? {};",
      "    const resolvedTag = component || (variant === 'h4' ? 'h4' : variant === 'h5' ? 'h5' : 'p');",
      "    const Tag = resolvedTag;",
      "    return (",
      "      <Tag",
      "        {...rest}",
      "        style={mergeStyle(",
      "          {",
      "            ...(align ? { textAlign: align } : {}),",
      "            ...(color === 'textSecondary' ? { color: '#6b7280' } : {}),",
      "          },",
      "          style,",
      "        )}",
      "      >",
      "        {children}",
      "      </Tag>",
      "    );",
      "  };",
      "  const TextField = (props) => {",
      "    const {",
      "      onChange,",
      "      onInput,",
      "      value,",
      "      label,",
      "      placeholder,",
      "      fullWidth,",
      "      type,",
      "      style,",
      "      ...rest",
      "    } = props ?? {};",
      "    return (",
      "      <input",
      "        {...rest}",
      "        type={type ?? 'text'}",
      "        value={value ?? ''}",
      "        placeholder={placeholder ?? label ?? ''}",
      "        onInput={(event) => {",
      "          if (typeof onInput === 'function') {",
      "            onInput(event);",
      "          }",
      "          if (typeof onChange === 'function') {",
      "            onChange(event);",
      "          }",
      "        }}",
      "        style={mergeStyle(",
      "          {",
      "            padding: '10px 12px',",
      "            borderRadius: '8px',",
      "            border: '1px solid #d1d5db',",
      "            ...(fullWidth ? { width: '100%' } : {}),",
      "          },",
      "          style,",
      "        )}",
      "      />",
      "    );",
      "  };",
      "  const Button = (props) => {",
      "    const { children, type, style, ...rest } = props ?? {};",
      "    return (",
      "      <button",
      "        {...rest}",
      "        type={type ?? 'button'}",
      "        style={mergeStyle(",
      "          {",
      "            padding: '10px 14px',",
      "            borderRadius: '8px',",
      "            border: '1px solid transparent',",
      "            background: '#2563eb',",
      "            color: '#fff',",
      "            cursor: 'pointer',",
      "          },",
      "          style,",
      "        )}",
      "      >",
      "        {children}",
      "      </button>",
      "    );",
      "  };",
      "  const IconButton = (props) => {",
      "    const { children, type, style, ...rest } = props ?? {};",
      "    return (",
      "      <button",
      "        {...rest}",
      "        type={type ?? 'button'}",
      "        style={mergeStyle(",
      "          {",
      "            border: 'none',",
      "            background: 'transparent',",
      "            padding: '6px',",
      "            borderRadius: '6px',",
      "            cursor: 'pointer',",
      "          },",
      "          style,",
      "        )}",
      "      >",
      "        {children}",
      "      </button>",
      "    );",
      "  };",
      "  const Checkbox = (props) => {",
      "    const { checked, onChange, onInput, style, ...rest } = props ?? {};",
      "    return (",
      "      <input",
      "        {...rest}",
      "        type='checkbox'",
      "        checked={Boolean(checked)}",
      "        onInput={(event) => {",
      "          if (typeof onInput === 'function') {",
      "            onInput(event);",
      "          }",
      "          if (typeof onChange === 'function') {",
      "            onChange(event);",
      "          }",
      "        }}",
      "        style={mergeStyle({ cursor: 'pointer' }, style)}",
      "      />",
      "    );",
      "  };",
      "  const List = (props) => <div {...(props ?? {})}>{props?.children}</div>;",
      "  const ListItem = (props) => <div {...(props ?? {})}>{props?.children}</div>;",
      "  const ListItemText = (props) => {",
      "    const { primary, secondary, style, ...rest } = props ?? {};",
      "    return (",
      "      <div {...rest} style={style}>",
      "        {primary ?? props?.children}",
      "        {secondary ? <small>{secondary}</small> : null}",
      "      </div>",
      "    );",
      "  };",
      "  return {",
      "    Box,",
      "    TextField,",
      "    Button,",
      "    List,",
      "    ListItem,",
      "    ListItemText,",
      "    IconButton,",
      "    Checkbox,",
      "    Typography,",
      "    Paper,",
      "    Container,",
      "  };",
      "})();",
      "const __renderifyMuiIcons = new Proxy(",
      "  {},",
      "  {",
      "    get: (_target, key) => {",
      "      const iconName = String(key ?? '');",
      "      const glyph = /delete/i.test(iconName) ? '[x]' : '*';",
      "      return (props) => <span aria-hidden='true' {...(props ?? {})}>{glyph}</span>;",
      "    },",
      "  },",
      ");",
    ].join("\n");
  }

  private isSyntheticSourceModuleSpecifier(
    specifier: string,
    source: RuntimeSourceModule | undefined,
    syntheticSourceSpecifiers?: Set<string>,
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

    if (syntheticSourceSpecifiers?.has(normalizedSpecifier)) {
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

  private collectSyntheticSourceSpecifiers(
    root: RuntimeNode,
    source: RuntimeSourceModule | undefined,
  ): Set<string> {
    const synthetic = new Set<string>();
    if (!source || root.type !== "component") {
      return synthetic;
    }

    const moduleSpecifier = root.module.trim();
    if (moduleSpecifier.length === 0) {
      return synthetic;
    }

    const normalizedSpecifier = moduleSpecifier.toLowerCase();
    if (
      normalizedSpecifier.startsWith("inline://") ||
      INLINE_SOURCE_MODULE_ALIASES.has(normalizedSpecifier) ||
      (!this.isHttpUrl(moduleSpecifier) &&
        !this.isPathLikeModuleSpecifier(moduleSpecifier))
    ) {
      synthetic.add(normalizedSpecifier);
    }

    return synthetic;
  }

  private isPathLikeModuleSpecifier(specifier: string): boolean {
    return (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/")
    );
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
