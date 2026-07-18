import type {
  LLMInterpreter,
  LLMRequest,
  LLMResponse,
  LLMResponseStreamChunk,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "@renderify/core";
import {
  hashStringFNV1a64Hex,
  isJsonValue,
  isRuntimeCapabilities,
  isRuntimeModuleManifest,
  isRuntimePlanMetadata,
  isRuntimeSourceLanguage,
  isRuntimeSourceRuntime,
  isRuntimeStateModel,
  normalizeRuntimeNodeCandidate,
  normalizeRuntimePlanCandidate,
} from "@renderify/ir";
import {
  consumeSseEvents,
  createLLMReliabilityState,
  createTimeoutAbortScope,
  fetchWithReliability,
  finalizeResponseBodyReader,
  formatContext,
  type LLMReliabilityOptions,
  pickFetch,
  pickLLMReliabilityOptions,
  pickPositiveInt,
  pickString,
  readErrorResponse,
  resolveFetch,
  resolveLLMReliabilityOptions,
  tryParseJson,
  withTimeoutAbortScope,
} from "./shared";

export interface OpenAICodexLLMInterpreterOptions {
  apiKey?: string;
  accessToken?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  accountId?: string;
  userAgent?: string;
  systemPrompt?: string;
  reasoningEffort?: OpenAICodexReasoningEffort;
  reliability?: LLMReliabilityOptions;
  fetchImpl?: typeof fetch;
}

export type OpenAICodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface OpenAICodexUsagePayload {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface OpenAICodexContentPart {
  type?: string;
  text?: string;
  refusal?: string | null;
}

interface OpenAICodexOutputItem {
  type?: string;
  status?: string;
  content?: OpenAICodexContentPart[] | string;
}

interface OpenAICodexResponsesPayload {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: OpenAICodexOutputItem[];
  usage?: OpenAICodexUsagePayload;
  error?: {
    code?: string;
    message?: string;
  };
  incomplete_details?: {
    reason?: string;
  };
}

interface OpenAICodexResponsesStreamPayload {
  type?: string;
  code?: string;
  message?: string;
  param?: string | null;
  delta?: string;
  text?: string;
  item?: OpenAICodexOutputItem;
  response?: OpenAICodexResponsesPayload;
  error?: {
    code?: string;
    message?: string;
  };
}

interface OpenAICodexExtractedOutput {
  text: string;
  refusal?: string;
}

interface OpenAICodexInputMessage {
  type: "message";
  role: "user";
  content: Array<{
    type: "input_text";
    text: string;
  }>;
}

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_USER_AGENT = "codex_cli_rs/0.0.0 (Renderify)";
const DEFAULT_INSTRUCTIONS = "You are Renderify Codex runtime.";
const SPARK_MODEL = "gpt-5.3-codex-spark";
const SPARK_REASONING_EFFORTS: ReadonlySet<OpenAICodexReasoningEffort> =
  new Set(["low", "medium", "high", "xhigh"]);
let codexFallbackPlanIdSequence = 0;

const createRuntimeNodeJsonSchema = (
  remainingDepth: number,
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: {
      type: "string",
      enum: ["text", "element", "component"],
    },
    value: { type: "string" },
    tag: { type: "string", minLength: 1 },
    module: { type: "string", minLength: 1 },
    exportName: { type: "string", minLength: 1 },
    props: { type: "object", additionalProperties: true },
    children: {
      type: "array",
      items:
        remainingDepth > 0
          ? createRuntimeNodeJsonSchema(remainingDepth - 1)
          : { type: "object", additionalProperties: true },
    },
  },
});

const RUNTIME_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["specVersion", "id", "version", "root", "capabilities"],
  properties: {
    specVersion: {
      type: "string",
      enum: ["runtime-plan/v1"],
    },
    id: {
      type: "string",
      minLength: 1,
    },
    version: {
      type: "integer",
      minimum: 1,
    },
    root: createRuntimeNodeJsonSchema(6),
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        domWrite: { type: "boolean" },
      },
    },
    imports: {
      type: "array",
      items: {
        type: "string",
      },
    },
    moduleManifest: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["resolvedUrl"],
        properties: {
          resolvedUrl: { type: "string", minLength: 1 },
          integrity: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          signer: { type: "string", minLength: 1 },
        },
      },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
    state: {
      type: "object",
      additionalProperties: false,
      required: ["initial"],
      properties: {
        initial: {
          type: "object",
          additionalProperties: true,
        },
        transitions: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["language", "code"],
      properties: {
        language: {
          type: "string",
          enum: ["js", "jsx", "ts", "tsx"],
        },
        code: {
          type: "string",
          minLength: 1,
        },
        exportName: {
          type: "string",
          minLength: 1,
        },
        runtime: {
          type: "string",
          enum: ["renderify", "preact"],
        },
      },
    },
  },
} as const;

const INVALID_RUNTIME_PLAN_ERROR =
  "Structured payload is not a valid RuntimePlan";
const MAX_RUNTIME_PLAN_DIAGNOSTICS = 8;

function collectRuntimeNodeDiagnostics(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (errors.length >= MAX_RUNTIME_PLAN_DIAGNOSTICS) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be a RuntimeNode object`);
    return;
  }

  const node = value as Record<string, unknown>;
  if (typeof node.type !== "string") {
    errors.push(`${path}.type must be "text", "element", or "component"`);
    return;
  }

  if (node.type === "text") {
    if (typeof node.value !== "string") {
      errors.push(`${path}.value must be a string for a text node`);
    }
    if (Object.hasOwn(node, "style")) {
      errors.push(
        `${path}.style is invalid on a text node; wrap it in an element and use props.style`,
      );
    }
    if (Object.hasOwn(node, "props") || Object.hasOwn(node, "children")) {
      errors.push(`${path} text nodes only accept type and value`);
    }
    return;
  }

  if (node.type === "element") {
    if (typeof node.tag !== "string" || node.tag.trim().length === 0) {
      errors.push(`${path}.tag must be a non-empty string for an element node`);
    }
  } else if (node.type === "component") {
    if (typeof node.module !== "string" || node.module.trim().length === 0) {
      errors.push(
        `${path}.module must be a non-empty string for a component node`,
      );
    }
    if (
      node.exportName !== undefined &&
      (typeof node.exportName !== "string" ||
        node.exportName.trim().length === 0)
    ) {
      errors.push(`${path}.exportName must be a non-empty string when present`);
    }
  } else {
    errors.push(`${path}.type must be "text", "element", or "component"`);
    return;
  }

  if (
    node.props !== undefined &&
    (typeof node.props !== "object" ||
      node.props === null ||
      Array.isArray(node.props) ||
      !isJsonValue(node.props))
  ) {
    errors.push(`${path}.props must be an object containing JSON values`);
  }
  if (Object.hasOwn(node, "style")) {
    errors.push(`${path}.style must be nested under ${path}.props.style`);
  }
  if (node.children === undefined) {
    return;
  }
  if (!Array.isArray(node.children)) {
    errors.push(`${path}.children must be an array of RuntimeNode objects`);
    return;
  }
  for (let index = 0; index < node.children.length; index += 1) {
    if (errors.length >= MAX_RUNTIME_PLAN_DIAGNOSTICS) {
      return;
    }
    if (!normalizeRuntimeNodeCandidate(node.children[index])) {
      collectRuntimeNodeDiagnostics(
        node.children[index],
        `${path}.children[${index}]`,
        errors,
      );
    }
  }
}

function collectRuntimePlanDiagnostics(value: unknown): string[] {
  const errors = [INVALID_RUNTIME_PLAN_ERROR];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("The top-level structured payload must be an object");
    return errors;
  }

  const plan = value as Record<string, unknown>;
  if (
    plan.id !== undefined &&
    (typeof plan.id !== "string" || plan.id.trim().length === 0)
  ) {
    errors.push("id must be a non-empty string when present");
  }
  if (
    plan.version !== undefined &&
    (typeof plan.version !== "number" ||
      !Number.isInteger(plan.version) ||
      plan.version <= 0)
  ) {
    errors.push("version must be a positive integer when present");
  }
  if (
    plan.specVersion !== undefined &&
    (typeof plan.specVersion !== "string" ||
      plan.specVersion.trim().length === 0)
  ) {
    errors.push("specVersion must be a non-empty string when present");
  }

  if (!Object.hasOwn(plan, "root")) {
    errors.push("root is required");
  } else if (!normalizeRuntimeNodeCandidate(plan.root)) {
    collectRuntimeNodeDiagnostics(plan.root, "root", errors);
  }
  if (
    Object.hasOwn(plan, "capabilities") &&
    !isRuntimeCapabilities(plan.capabilities)
  ) {
    errors.push(
      "capabilities contains invalid values; omit unused entries or use the RuntimeCapabilities types",
    );
  }
  if (
    Object.hasOwn(plan, "imports") &&
    (!Array.isArray(plan.imports) ||
      plan.imports.some((entry) => typeof entry !== "string"))
  ) {
    errors.push("imports must be an array of strings");
  }
  if (
    Object.hasOwn(plan, "moduleManifest") &&
    !isRuntimeModuleManifest(plan.moduleManifest)
  ) {
    errors.push(
      "moduleManifest must map module specifiers to descriptors with a non-empty resolvedUrl",
    );
  }
  if (Object.hasOwn(plan, "state") && !isRuntimeStateModel(plan.state)) {
    errors.push(
      "state must contain an initial object and optional valid transitions; omit state when unused",
    );
  }
  if (Object.hasOwn(plan, "source")) {
    const source = plan.source;
    if (
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source)
    ) {
      errors.push("source must be an object; omit source when unused");
    } else {
      const sourceRecord = source as Record<string, unknown>;
      if (
        typeof sourceRecord.code !== "string" ||
        sourceRecord.code.trim().length === 0
      ) {
        errors.push("source.code must be a non-empty string");
      }
      if (!isRuntimeSourceLanguage(sourceRecord.language)) {
        errors.push('source.language must be "js", "jsx", "ts", or "tsx"');
      }
      if (
        sourceRecord.runtime !== undefined &&
        !isRuntimeSourceRuntime(sourceRecord.runtime)
      ) {
        errors.push(
          'source.runtime must be "renderify" or "preact"; omit source for declarative plans',
        );
      }
    }
  }
  if (
    Object.hasOwn(plan, "metadata") &&
    !isRuntimePlanMetadata(plan.metadata)
  ) {
    errors.push("metadata must contain only JSON values and string tags");
  }

  return errors.slice(0, MAX_RUNTIME_PLAN_DIAGNOSTICS + 1);
}

export class OpenAICodexLLMInterpreter implements LLMInterpreter {
  private readonly templates = new Map<string, string>();
  private options: Required<
    Pick<
      OpenAICodexLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "userAgent"
    >
  > &
    Omit<
      OpenAICodexLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "userAgent" | "fetchImpl"
    > = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    userAgent: DEFAULT_USER_AGENT,
    apiKey: undefined,
    accessToken: undefined,
    accountId: undefined,
    systemPrompt: undefined,
    reasoningEffort: undefined,
  };
  private fetchImpl: typeof fetch | undefined;
  private reliability = resolveLLMReliabilityOptions();
  private readonly reliabilityState = createLLMReliabilityState();

  constructor(options: OpenAICodexLLMInterpreterOptions = {}) {
    this.configure({ ...options });
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    }
  }

  configure(options: Record<string, unknown>): void {
    const apiKey = pickString(options, "apiKey", "accessToken", "llmApiKey");
    const model = pickString(options, "model", "llmModel");
    const baseUrl = pickString(options, "baseUrl", "llmBaseUrl");
    const accountId = pickString(options, "accountId", "codexAccountId");
    const userAgent = pickString(options, "userAgent", "codexUserAgent");
    const systemPrompt = pickString(options, "systemPrompt");
    const reasoningEffort = readReasoningEffort(options);
    const timeoutMs = pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const fetchImpl = pickFetch(options, "fetchImpl");
    const reliability = pickLLMReliabilityOptions(options);

    const nextOptions = {
      ...this.options,
      ...(apiKey !== undefined ? { apiKey, accessToken: apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    validateReasoningEffortForModel(
      nextOptions.model,
      nextOptions.reasoningEffort,
    );
    this.options = nextOptions;

    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    }

    if (reliability) {
      this.reliability = resolveLLMReliabilityOptions(
        reliability,
        this.reliability,
      );
    }
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const payload = await this.requestResponses(
      {
        model: this.options.model,
        instructions: this.buildInstructions(req),
        input: this.buildInputItems(req),
        store: false,
      },
      req.signal,
    );

    const output = this.extractOutput(payload);
    if (output.refusal) {
      throw new Error(`OpenAI Codex refused request: ${output.refusal}`);
    }

    return {
      text: output.text,
      tokensUsed: resolveTokensUsed(payload.usage),
      model: payload.model ?? this.options.model,
      raw: {
        mode: "text",
        responseId: payload.id,
      },
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in OpenAICodexLLMInterpreter options.",
    );
    const accessToken = this.resolveAccessToken();
    const abortScope = createTimeoutAbortScope(
      this.options.timeoutMs,
      req.signal,
    );

    let aggregatedText = "";
    let chunkIndex = 0;
    let tokensUsed: number | undefined;
    let model = this.options.model;
    let doneEmitted = false;

    const emitDone = (): LLMResponseStreamChunk | undefined => {
      if (doneEmitted) {
        return undefined;
      }

      chunkIndex += 1;
      doneEmitted = true;
      return {
        delta: "",
        text: aggregatedText,
        done: true,
        index: chunkIndex,
        tokensUsed,
        model,
        raw: {
          mode: "stream",
          done: true,
        },
      };
    };

    const emitDelta = (
      delta: string,
      raw: Record<string, unknown>,
    ): LLMResponseStreamChunk | undefined => {
      if (delta.length === 0) {
        return undefined;
      }

      aggregatedText += delta;
      chunkIndex += 1;
      return {
        delta,
        text: aggregatedText,
        done: false,
        index: chunkIndex,
        tokensUsed,
        model,
        raw,
      };
    };

    const processEvents = (
      events: Array<{ event?: string; data: string }>,
    ): LLMResponseStreamChunk[] => {
      const chunks: LLMResponseStreamChunk[] = [];

      for (const event of events) {
        if (event.data === "[DONE]") {
          const done = emitDone();
          if (done) {
            chunks.push(done);
          }
          continue;
        }

        let payload: OpenAICodexResponsesStreamPayload;
        try {
          payload = JSON.parse(event.data) as OpenAICodexResponsesStreamPayload;
        } catch (error) {
          throw new Error(
            `OpenAI Codex stream chunk parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        const eventType = payload.type ?? event.event ?? "";
        throwIfCodexStreamEventFailed(payload, eventType);

        const response = payload.response;
        if (response) {
          if (
            typeof response.model === "string" &&
            response.model.trim().length > 0
          ) {
            model = response.model;
          }

          const responseTokens = resolveTokensUsed(response.usage);
          if (responseTokens !== undefined) {
            tokensUsed = responseTokens;
          }
        }

        throwIfCodexResponseFailed(response, eventType);

        if (eventType === "response.completed") {
          if (response && aggregatedText.length === 0) {
            const finalOutput = this.extractOutput(response);
            if (finalOutput.refusal) {
              throw new Error(
                `OpenAI Codex refused request: ${finalOutput.refusal}`,
              );
            }
            const chunk = emitDelta(finalOutput.text, {
              mode: "stream",
              event: payload,
            });
            if (chunk) {
              chunks.push(chunk);
            }
          }
          const done = emitDone();
          if (done) {
            chunks.push(done);
          }
          continue;
        }

        if (eventType === "response.output_item.done" && payload.item) {
          const itemOutput = this.extractItemOutput(payload.item);
          if (itemOutput.refusal) {
            throw new Error(
              `OpenAI Codex refused request: ${itemOutput.refusal}`,
            );
          }
          if (aggregatedText.length === 0) {
            const chunk = emitDelta(itemOutput.text, {
              mode: "stream",
              event: payload,
            });
            if (chunk) {
              chunks.push(chunk);
            }
          }
          continue;
        }

        if (eventType.includes("refusal")) {
          const refusal = payload.delta ?? payload.text ?? "";
          if (refusal.trim().length > 0) {
            throw new Error(`OpenAI Codex refused request: ${refusal.trim()}`);
          }
        }

        if (eventType.includes("output_text.delta")) {
          const delta = payload.delta ?? payload.text ?? "";
          const chunk = emitDelta(delta, {
            mode: "stream",
            event: payload,
          });
          if (chunk) {
            chunks.push(chunk);
          }
        }
      }

      return chunks;
    };

    try {
      const response = await fetchWithReliability({
        fetchImpl,
        input: `${this.options.baseUrl.replace(/\/$/, "")}/responses`,
        init: {
          method: "POST",
          headers: this.createHeaders(accessToken),
          body: JSON.stringify({
            model: this.options.model,
            instructions: this.buildInstructions(req),
            input: this.buildInputItems(req),
            store: false,
            ...this.createReasoningPayload(),
            stream: true,
          }),
          signal: abortScope.signal,
        },
        reliability: this.reliability,
        state: this.reliabilityState,
        operationName: "OpenAI Codex request",
      });

      if (!response.ok) {
        const details = await readErrorResponse(response);
        throw new Error(
          `OpenAI Codex request failed (${response.status}): ${details}`,
        );
      }

      if (!response.body) {
        throw new Error("OpenAI Codex streaming response body is empty");
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";
      let reachedEndOfStream = false;

      try {
        while (true) {
          const { done, value } = await readCodexStreamChunk(
            reader,
            abortScope.signal,
          );
          if (done) {
            reachedEndOfStream = true;
            break;
          }

          if (value) {
            buffer += decoder.decode(value, { stream: true });
          }

          const parsedEvents = consumeSseEvents(buffer);
          buffer = parsedEvents.remaining;

          for (const chunk of processEvents(parsedEvents.events)) {
            yield chunk;
          }
        }

        buffer += decoder.decode();
        const finalEvents = consumeSseEvents(buffer, true);
        for (const chunk of processEvents(finalEvents.events)) {
          yield chunk;
        }
      } finally {
        await finalizeResponseBodyReader(reader, reachedEndOfStream);
      }

      if (!doneEmitted) {
        chunkIndex += 1;
        doneEmitted = true;
        yield {
          delta: "",
          text: aggregatedText,
          done: true,
          index: chunkIndex,
          tokensUsed,
          model,
          raw: {
            mode: "stream",
            done: true,
            reason: "eof",
          },
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (req.signal?.aborted) {
          throw new Error("OpenAI Codex request aborted by caller");
        }
        throw new Error(
          `OpenAI Codex request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      abortScope.release();
    }
  }

  async generateStructuredResponse<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>> {
    if (req.format !== "runtime-plan") {
      return {
        text: "",
        valid: false,
        errors: [`Unsupported structured format: ${String(req.format)}`],
        model: this.options.model,
      };
    }

    const payload = await this.requestResponses(
      {
        model: this.options.model,
        instructions: this.resolveStructuredSystemPrompt(req),
        input: this.buildInputItems(req),
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "runtime_plan",
            strict: false,
            schema: RUNTIME_PLAN_JSON_SCHEMA,
          },
        },
      },
      req.signal,
    );

    const output = this.extractOutput(payload);

    if (output.refusal) {
      return {
        text: "",
        valid: false,
        errors: [`OpenAI Codex refusal: ${output.refusal}`],
        tokensUsed: resolveTokensUsed(payload.usage),
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
          refusal: output.refusal,
        },
      };
    }

    if (output.text.trim().length === 0) {
      return {
        text: "",
        valid: false,
        errors: ["Structured response content is empty"],
        tokensUsed: resolveTokensUsed(payload.usage),
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    const parsed = tryParseJson(output.text);
    if (!parsed.ok) {
      return {
        text: output.text,
        valid: false,
        errors: [`Structured JSON parse failed: ${parsed.error}`],
        tokensUsed: resolveTokensUsed(payload.usage),
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    const normalizedPlan = normalizeRuntimePlanCandidate(parsed.value, {
      fallbackId: this.createFallbackPlanId(req.prompt, payload.id),
    });
    if (!normalizedPlan) {
      return {
        text: output.text,
        value: parsed.value as T,
        valid: false,
        errors: collectRuntimePlanDiagnostics(parsed.value),
        tokensUsed: resolveTokensUsed(payload.usage),
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    const normalized = normalizedPlan !== parsed.value;
    return {
      text: normalized ? JSON.stringify(normalizedPlan) : output.text,
      value: normalizedPlan as T,
      valid: true,
      tokensUsed: resolveTokensUsed(payload.usage),
      model: payload.model ?? this.options.model,
      raw: {
        mode: "structured",
        responseId: payload.id,
        ...(normalized ? { normalized: true } : {}),
      },
    };
  }

  setPromptTemplate(templateName: string, templateContent: string): void {
    this.templates.set(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.templates.get(templateName);
  }

  private async requestResponses(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAICodexResponsesPayload> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in OpenAICodexLLMInterpreter options.",
    );
    const accessToken = this.resolveAccessToken();
    const maxTimeoutAttempts =
      this.reliability.retryOnNetworkError && this.reliability.maxRetries > 0
        ? 2
        : 1;

    for (let attempt = 1; attempt <= maxTimeoutAttempts; attempt += 1) {
      try {
        return await withTimeoutAbortScope(
          this.options.timeoutMs,
          signal,
          async (timeoutSignal) => {
            const response = await fetchWithReliability({
              fetchImpl,
              input: `${this.options.baseUrl.replace(/\/$/, "")}/responses`,
              init: {
                method: "POST",
                headers: this.createHeaders(accessToken),
                body: JSON.stringify({
                  ...body,
                  ...this.createReasoningPayload(),
                  stream: true,
                }),
                signal: timeoutSignal,
              },
              reliability: this.reliability,
              state: this.reliabilityState,
              operationName: "OpenAI Codex request",
            });

            if (!response.ok) {
              const details = await readErrorResponse(response);
              throw new Error(
                `OpenAI Codex request failed (${response.status}): ${details}`,
              );
            }

            if (!response.body) {
              throw new Error("OpenAI Codex streaming response body is empty");
            }

            return await this.readCompletedStreamResponse(
              response.body,
              timeoutSignal,
            );
          },
        );
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") {
          throw error;
        }
        if (signal?.aborted) {
          throw new Error("OpenAI Codex request aborted by caller");
        }
        if (attempt < maxTimeoutAttempts) {
          continue;
        }
        throw new Error(
          `OpenAI Codex request timed out after ${this.options.timeoutMs}ms`,
        );
      }
    }

    throw new Error("OpenAI Codex request failed: retries exhausted");
  }

  private async readCompletedStreamResponse(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<OpenAICodexResponsesPayload> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    let completed: OpenAICodexResponsesPayload | undefined;
    let outputText = "";
    let reachedEndOfStream = false;

    const processEvents = (events: Array<{ event?: string; data: string }>) => {
      for (const event of events) {
        if (event.data === "[DONE]") {
          continue;
        }

        let payload: OpenAICodexResponsesStreamPayload;
        try {
          payload = JSON.parse(event.data) as OpenAICodexResponsesStreamPayload;
        } catch (error) {
          throw new Error(
            `OpenAI Codex stream chunk parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        const eventType = payload.type ?? event.event ?? "";
        throwIfCodexStreamEventFailed(payload, eventType);
        throwIfCodexResponseFailed(payload.response, eventType);

        if (eventType.includes("output_text.delta")) {
          outputText += payload.delta ?? payload.text ?? "";
        }

        if (eventType === "response.output_item.done" && payload.item) {
          const itemOutput = this.extractItemOutput(payload.item);
          if (itemOutput.refusal) {
            throw new Error(
              `OpenAI Codex refused request: ${itemOutput.refusal}`,
            );
          }
          if (outputText.length === 0) {
            outputText += itemOutput.text;
          }
        }

        if (eventType === "response.completed" && payload.response) {
          completed = payload.response;
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await readCodexStreamChunk(reader, signal);
        if (done) {
          reachedEndOfStream = true;
          break;
        }

        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        const parsedEvents = consumeSseEvents(buffer);
        buffer = parsedEvents.remaining;
        processEvents(parsedEvents.events);
      }

      buffer += decoder.decode();
      const finalEvents = consumeSseEvents(buffer, true);
      processEvents(finalEvents.events);
    } finally {
      await finalizeResponseBodyReader(reader, reachedEndOfStream);
    }

    if (!completed) {
      throw new Error(
        "OpenAI Codex streaming response missing response.completed event",
      );
    }

    if (
      outputText.trim().length > 0 &&
      typeof completed.output_text !== "string" &&
      (!Array.isArray(completed.output) || completed.output.length === 0)
    ) {
      completed = {
        ...completed,
        output_text: outputText,
      };
    }

    throwIfCodexResponseFailed(completed, "response.completed");

    return completed;
  }

  private resolveAccessToken(): string {
    const accessToken = this.options.accessToken ?? this.options.apiKey;
    if (!accessToken || accessToken.trim().length === 0) {
      throw new Error(
        "OpenAI Codex access token is missing. Run `renderify auth codex login`, set RENDERIFY_CODEX_ACCESS_TOKEN, or configure accessToken.",
      );
    }

    return accessToken.trim();
  }

  private createReasoningPayload(): {
    reasoning?: { effort: OpenAICodexReasoningEffort };
  } {
    const effort =
      this.options.reasoningEffort ??
      (this.options.model === SPARK_MODEL ? "low" : undefined);
    return effort ? { reasoning: { effort } } : {};
  }

  private createFallbackPlanId(prompt: string, responseId?: string): string {
    codexFallbackPlanIdSequence += 1;
    const responseKey =
      typeof responseId === "string" && responseId.trim().length > 0
        ? responseId.trim()
        : "response-without-id";
    const uniqueInput = [
      responseKey,
      prompt,
      Date.now().toString(36),
      codexFallbackPlanIdSequence.toString(36),
    ].join("\0");
    return `renderify_${hashStringFNV1a64Hex(uniqueInput)}`;
  }

  private buildInstructions(req: LLMRequest): string {
    const instructions: string[] = [];
    const templateSystem = this.templates.get("default");
    const promptSystem = req.systemPrompt;
    const configuredSystem = this.options.systemPrompt;

    for (const system of [configuredSystem, templateSystem, promptSystem]) {
      if (typeof system === "string" && system.trim().length > 0) {
        instructions.push(system.trim());
      }
    }

    return instructions.length > 0
      ? instructions.join("\n\n")
      : DEFAULT_INSTRUCTIONS;
  }

  private buildInput(req: LLMRequest): string {
    const contextSnippet = formatContext(req.context);
    return contextSnippet
      ? `${req.prompt}\n\nContext:\n${contextSnippet}`
      : req.prompt;
  }

  private buildInputItems(req: LLMRequest): OpenAICodexInputMessage[] {
    return [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: this.buildInput(req),
          },
        ],
      },
    ];
  }

  private resolveStructuredSystemPrompt(req: LLMStructuredRequest): string {
    const template = this.templates.get("runtime-plan");
    if (template && template.trim().length > 0) {
      return template;
    }

    const base = this.buildInstructions(req);
    const strictHint = req.strict === false ? "false" : "true";
    const structured = [
      "You generate RuntimePlan JSON for Renderify.",
      "Return only JSON with no markdown or explanations.",
      'Use specVersion exactly as "runtime-plan/v1".',
      "Schema priority: id/version/root/capabilities must be valid.",
      'RuntimeNode shapes are exactly text={"type":"text","value":"..."}, element={"type":"element","tag":"div","props":{},"children":[]}, or component={"type":"component","module":"...","exportName":"default","props":{},"children":[]}.',
      'Children must recursively use those shapes. Never put an HTML tag such as "div" in type; use type="element" and tag="div". Put inline styles under props.style, not directly on the node.',
      "Text nodes only accept type and value; wrap styled text in an element node.",
      "Omit imports, moduleManifest, metadata, state, and source unless they are actually needed. If state is present it must contain an initial object. For declarative element/text roots, omit source.",
      "Do not emit maxImports, maxComponentInvocations, or maxExecutionMs; those resource budgets are controlled by the host security policy.",
      "Within capabilities, emit only domWrite. Do not request networkHosts, allowedModules, timers, storage, or executionProfile; host policy and code generation derive permissions.",
      "Do not set root.type to component unless source.code is present with a matching export.",
      'Do not include synthetic source module aliases such as "this-plan-source" in imports, capabilities.allowedModules, or moduleManifest.',
      'Do not use local path aliases such as "@/..." in any import or module URL.',
      'Do not emit wildcard module specifiers such as "https://esm.sh/*".',
      "When using third-party UI libraries, prefer bare npm specifiers (for example @mui/material) over direct CDN URLs.",
      "When third-party UI libraries are unavailable, use plain JSX/HTML components instead of fake CDN paths.",
      'If source.language is jsx/tsx and code uses React-like hooks/imports, set source.runtime to "preact".',
      'If source.runtime is "preact", the plan must be rendered through the trusted browser source lane (for example renderTrustedPlanInBrowser or the "trusted" security profile).',
      "For preact source modules, import hooks from preact/compat or preact/hooks (not renderify).",
      `Strict mode: ${strictHint}.`,
    ].join(" ");

    return base ? `${base}\n\n${structured}` : structured;
  }

  private createHeaders(accessToken: string): Record<string, string> {
    const accountId =
      this.options.accountId ?? resolveChatGptAccountId(accessToken);
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "User-Agent": this.options.userAgent,
      originator: "codex_cli_rs",
    };

    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }

    return headers;
  }

  private extractOutput(
    payload: OpenAICodexResponsesPayload,
  ): OpenAICodexExtractedOutput {
    if (typeof payload.output_text === "string") {
      return {
        text: payload.output_text.trim(),
      };
    }

    const output = payload.output;
    if (!Array.isArray(output) || output.length === 0) {
      throw new Error("OpenAI Codex response missing output items");
    }

    let text = "";
    for (const item of output) {
      const itemOutput = this.extractItemOutput(item);
      if (itemOutput.refusal) {
        return itemOutput;
      }
      text += itemOutput.text;
    }

    return {
      text: text.trim(),
    };
  }

  private extractItemOutput(
    item: OpenAICodexOutputItem,
  ): OpenAICodexExtractedOutput {
    const content = item.content;
    if (typeof content === "string") {
      return {
        text: content,
      };
    }

    if (!Array.isArray(content)) {
      return {
        text: "",
      };
    }

    let text = "";
    for (const part of content) {
      if (typeof part.refusal === "string" && part.refusal.trim().length > 0) {
        return {
          text: "",
          refusal: part.refusal.trim(),
        };
      }

      if (part.type !== "output_text" && part.type !== "text") {
        continue;
      }

      if (typeof part.text === "string") {
        text += part.text;
      }
    }

    return {
      text,
    };
  }
}

function throwIfCodexStreamEventFailed(
  payload: OpenAICodexResponsesStreamPayload,
  eventType: string,
): void {
  const isTopLevelError = eventType === "error";
  const code =
    normalizeErrorField(payload.code) ??
    normalizeErrorField(payload.error?.code);
  const message =
    normalizeErrorField(payload.message) ??
    normalizeErrorField(payload.error?.message);

  if (!isTopLevelError && !code && !message) {
    return;
  }

  let errorMessage = "OpenAI Codex stream error";
  if (code) {
    errorMessage += ` (${code})`;
  }
  if (message) {
    errorMessage += `: ${message}`;
  }

  const param = normalizeErrorField(payload.param);
  if (isTopLevelError && param) {
    errorMessage += ` [param: ${param}]`;
  }

  throw new Error(errorMessage);
}

function throwIfCodexResponseFailed(
  response: OpenAICodexResponsesPayload | undefined,
  eventType: string,
): void {
  const responseStatus = normalizeErrorField(response?.status)?.toLowerCase();
  const eventStatus = codexTerminalStatusFromEvent(eventType);
  const failureStatus = isCodexFailureStatus(responseStatus)
    ? responseStatus
    : isCodexFailureStatus(eventStatus)
      ? eventStatus
      : undefined;
  const code = normalizeErrorField(response?.error?.code);
  const message = normalizeErrorField(response?.error?.message);
  const reason = normalizeErrorField(response?.incomplete_details?.reason);

  if (!failureStatus && !code && !message && !reason) {
    return;
  }

  const status = failureStatus ?? (reason ? "incomplete" : "failed");
  let errorMessage = `OpenAI Codex response ${status}`;
  if (code) {
    errorMessage += ` (${code})`;
  }

  const details: string[] = [];
  if (message) {
    details.push(message);
  }
  if (reason && reason !== message) {
    details.push(message ? `reason: ${reason}` : reason);
  }
  if (details.length > 0) {
    errorMessage += `: ${details.join("; ")}`;
  }

  throw new Error(errorMessage);
}

function codexTerminalStatusFromEvent(eventType: string): string | undefined {
  switch (eventType) {
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    case "response.cancelled":
    case "response.canceled":
      return "cancelled";
    default:
      return undefined;
  }
}

function isCodexFailureStatus(status: string | undefined): boolean {
  return (
    status === "failed" ||
    status === "incomplete" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function normalizeErrorField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveTokensUsed(
  usage: OpenAICodexUsagePayload | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }

  if (
    typeof usage.total_tokens === "number" &&
    Number.isFinite(usage.total_tokens)
  ) {
    return usage.total_tokens;
  }

  const inputTokens =
    typeof usage.input_tokens === "number" &&
    Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" &&
    Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : undefined;

  if (inputTokens !== undefined || outputTokens !== undefined) {
    return (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  return undefined;
}

function createCodexAbortError(): Error {
  const error = new Error("OpenAI Codex request aborted");
  error.name = "AbortError";
  return error;
}

function readCodexStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }

  if (signal.aborted) {
    return Promise.reject(createCodexAbortError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(createCodexAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });

    reader.read().then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeReasoningEffort(
  value: string | undefined,
): OpenAICodexReasoningEffort | undefined {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }

  return undefined;
}

function readReasoningEffort(
  options: Record<string, unknown>,
): OpenAICodexReasoningEffort | undefined {
  const value =
    options.reasoningEffort !== undefined
      ? options.reasoningEffort
      : options.llmReasoningEffort;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      "OpenAI Codex reasoning effort must be a string when provided.",
    );
  }

  const normalized = normalizeReasoningEffort(value.trim());
  if (!normalized) {
    throw new Error(
      `Invalid OpenAI Codex reasoning effort "${value}". Expected one of: none, minimal, low, medium, high, xhigh, max.`,
    );
  }
  return normalized;
}

function validateReasoningEffortForModel(
  model: string,
  effort: OpenAICodexReasoningEffort | undefined,
): void {
  if (
    model === SPARK_MODEL &&
    effort !== undefined &&
    !SPARK_REASONING_EFFORTS.has(effort)
  ) {
    throw new Error(
      `Reasoning effort "${effort}" is not supported by ${SPARK_MODEL}. Supported efforts: low, medium, high, xhigh.`,
    );
  }
}

function resolveChatGptAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) {
      return undefined;
    }

    const claims = decodeBase64UrlJson(parts[1]);
    if (!isRecord(claims)) {
      return undefined;
    }

    const authClaims = claims["https://api.openai.com/auth"];
    if (!isRecord(authClaims)) {
      return undefined;
    }

    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim().length > 0
      ? accountId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64UrlJson(segment: string): unknown {
  const normalized = `${segment.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (segment.length % 4)) % 4,
  )}`;
  const decoded =
    typeof globalThis.atob === "function"
      ? globalThis.atob(normalized)
      : Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(decoded) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
