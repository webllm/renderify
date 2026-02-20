import type {
  LLMInterpreter,
  LLMRequest,
  LLMResponse,
  LLMResponseStreamChunk,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "@renderify/core";
import { isRuntimePlan } from "@renderify/ir";
import {
  consumeSseEvents,
  createLLMReliabilityState,
  createTimeoutAbortScope,
  fetchWithReliability,
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

export interface GoogleLLMInterpreterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  reliability?: LLMReliabilityOptions;
  fetchImpl?: typeof fetch;
}

interface GoogleContentPart {
  text?: string;
}

interface GoogleCandidatePayload {
  content?: {
    parts?: GoogleContentPart[];
  };
  finishReason?: string;
}

interface GoogleGenerateContentPayload {
  candidates?: GoogleCandidatePayload[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  error?: {
    message?: string;
  };
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30000;
const RUNTIME_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["id", "version", "root", "capabilities"],
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
    root: {
      type: "object",
      required: ["type"],
      additionalProperties: true,
      properties: {
        type: {
          type: "string",
          enum: ["text", "element", "component"],
        },
        value: {
          type: "string",
        },
        tag: {
          type: "string",
          minLength: 1,
        },
        module: {
          type: "string",
          minLength: 1,
        },
        exportName: {
          type: "string",
          minLength: 1,
        },
        props: {
          type: "object",
          additionalProperties: true,
        },
        children: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    capabilities: {
      type: "object",
      required: ["domWrite"],
      additionalProperties: true,
      properties: {
        domWrite: {
          type: "boolean",
        },
        allowedModules: {
          type: "array",
          items: {
            type: "string",
          },
        },
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
      additionalProperties: true,
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

export class GoogleLLMInterpreter implements LLMInterpreter {
  private readonly templates = new Map<string, string>();
  private options: Required<
    Pick<GoogleLLMInterpreterOptions, "baseUrl" | "model" | "timeoutMs">
  > &
    Omit<
      GoogleLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "fetchImpl"
    > = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    apiKey: undefined,
    systemPrompt: undefined,
  };
  private fetchImpl: typeof fetch | undefined;
  private reliability = resolveLLMReliabilityOptions();
  private readonly reliabilityState = createLLMReliabilityState();

  constructor(options: GoogleLLMInterpreterOptions = {}) {
    this.configure({ ...options });
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    }
  }

  configure(options: Record<string, unknown>): void {
    const apiKey = pickString(options, "apiKey", "llmApiKey");
    const model = pickString(options, "model", "llmModel");
    const baseUrl = pickString(options, "baseUrl", "llmBaseUrl");
    const systemPrompt = pickString(options, "systemPrompt");
    const timeoutMs = pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const fetchImpl = pickFetch(options, "fetchImpl");
    const reliability = pickLLMReliabilityOptions(options);

    this.options = {
      ...this.options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

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
    const payload = await this.requestGenerateContent(
      this.buildRequest(req),
      req.signal,
    );
    const refusal = this.extractRefusal(payload);
    if (refusal) {
      throw new Error(`Google refused request: ${refusal}`);
    }

    return {
      text: this.extractText(payload),
      tokensUsed: this.extractTotalTokens(payload),
      model: payload.modelVersion ?? this.options.model,
      raw: {
        mode: "text",
        finishReason: payload.candidates?.[0]?.finishReason,
      },
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in GoogleLLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "Google apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    const abortScope = createTimeoutAbortScope(
      this.options.timeoutMs,
      req.signal,
    );

    let aggregatedText = "";
    let chunkIndex = 0;
    let tokensUsed: number | undefined;
    let model = this.options.model;
    let doneEmitted = false;

    const processEvents = (
      events: Array<{ data: string }>,
    ): Array<LLMResponseStreamChunk> => {
      const chunks: LLMResponseStreamChunk[] = [];

      for (const event of events) {
        if (event.data === "[DONE]") {
          if (!doneEmitted) {
            chunkIndex += 1;
            doneEmitted = true;
            chunks.push({
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
            });
          }
          continue;
        }

        let payload: GoogleGenerateContentPayload;
        try {
          payload = JSON.parse(event.data) as GoogleGenerateContentPayload;
        } catch (error) {
          throw new Error(
            `Google stream chunk parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (payload.error?.message) {
          throw new Error(`Google error: ${payload.error.message}`);
        }

        if (
          typeof payload.modelVersion === "string" &&
          payload.modelVersion.trim().length > 0
        ) {
          model = payload.modelVersion;
        }

        const refusal = this.extractRefusal(payload);
        if (refusal) {
          throw new Error(`Google refused request: ${refusal}`);
        }

        const payloadTokens = this.extractTotalTokens(payload);
        if (typeof payloadTokens === "number") {
          tokensUsed = payloadTokens;
        }

        const deltaText = this.extractTextRaw(payload);
        if (deltaText.length === 0) {
          continue;
        }

        aggregatedText += deltaText;
        chunkIndex += 1;
        chunks.push({
          delta: deltaText,
          text: aggregatedText,
          done: false,
          index: chunkIndex,
          tokensUsed,
          model,
          raw: {
            mode: "stream",
            chunk: payload,
          },
        });
      }

      return chunks;
    };

    try {
      const response = await fetchWithReliability({
        fetchImpl,
        input: `${this.options.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(this.options.model)}:streamGenerateContent?alt=sse`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(this.buildRequest(req)),
          signal: abortScope.signal,
        },
        reliability: this.reliability,
        state: this.reliabilityState,
        operationName: "Google request",
      });

      if (!response.ok) {
        const details = await readErrorResponse(response);
        throw new Error(
          `Google request failed (${response.status}): ${details}`,
        );
      }

      if (!response.body) {
        throw new Error("Google streaming response body is empty");
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
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
          throw new Error("Google request aborted by caller");
        }
        throw new Error(
          `Google request timed out after ${this.options.timeoutMs}ms`,
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

    let payload: GoogleGenerateContentPayload;
    try {
      payload = await this.requestGenerateContent(
        this.buildStructuredRequest(req, true),
        req.signal,
      );
    } catch (error) {
      if (!this.shouldRetryStructuredWithoutSchema(error)) {
        throw error;
      }

      payload = await this.requestGenerateContent(
        this.buildStructuredRequest(req, false),
        req.signal,
      );
    }

    const refusal = this.extractRefusal(payload);
    if (refusal) {
      return {
        text: "",
        valid: false,
        errors: [`Google refusal: ${refusal}`],
        tokensUsed: this.extractTotalTokens(payload),
        model: payload.modelVersion ?? this.options.model,
        raw: {
          mode: "structured",
          finishReason: payload.candidates?.[0]?.finishReason,
        },
      };
    }

    const text = this.extractText(payload);
    if (text.trim().length === 0) {
      return {
        text,
        valid: false,
        errors: ["Structured response content is empty"],
        tokensUsed: this.extractTotalTokens(payload),
        model: payload.modelVersion ?? this.options.model,
        raw: {
          mode: "structured",
          finishReason: payload.candidates?.[0]?.finishReason,
        },
      };
    }

    const parsed = tryParseJson(text);
    if (!parsed.ok) {
      return {
        text,
        valid: false,
        errors: [`Structured JSON parse failed: ${parsed.error}`],
        tokensUsed: this.extractTotalTokens(payload),
        model: payload.modelVersion ?? this.options.model,
        raw: {
          mode: "structured",
          finishReason: payload.candidates?.[0]?.finishReason,
        },
      };
    }

    if (!isRuntimePlan(parsed.value)) {
      return {
        text,
        value: parsed.value as T,
        valid: false,
        errors: ["Structured payload is not a valid RuntimePlan"],
        tokensUsed: this.extractTotalTokens(payload),
        model: payload.modelVersion ?? this.options.model,
        raw: {
          mode: "structured",
          finishReason: payload.candidates?.[0]?.finishReason,
        },
      };
    }

    return {
      text,
      value: parsed.value as T,
      valid: true,
      tokensUsed: this.extractTotalTokens(payload),
      model: payload.modelVersion ?? this.options.model,
      raw: {
        mode: "structured",
        finishReason: payload.candidates?.[0]?.finishReason,
      },
    };
  }

  setPromptTemplate(templateName: string, templateContent: string): void {
    this.templates.set(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.templates.get(templateName);
  }

  private buildRequest(req: LLMRequest): Record<string, unknown> {
    const system = this.resolveSystemPrompt(req);
    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: this.buildUserPrompt(req),
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "text/plain",
      },
    };

    if (system) {
      body.systemInstruction = {
        parts: [
          {
            text: system,
          },
        ],
      };
    }

    return body;
  }

  private buildStructuredRequest(
    req: LLMStructuredRequest,
    includeJsonSchema: boolean,
  ): Record<string, unknown> {
    const body = this.buildRequest({
      ...req,
      systemPrompt: this.resolveStructuredSystemPrompt(req),
    });

    body.generationConfig = {
      responseMimeType: "application/json",
      ...(includeJsonSchema
        ? {
            responseJsonSchema: RUNTIME_PLAN_JSON_SCHEMA,
          }
        : {}),
    };

    return body;
  }

  private shouldRetryStructuredWithoutSchema(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("responsejsonschema") ||
      message.includes("response_json_schema") ||
      message.includes("response_schema")
    );
  }

  private resolveSystemPrompt(req: LLMRequest): string | undefined {
    const configuredSystem = this.options.systemPrompt;
    const templateSystem = this.templates.get("default");
    const requestSystem = req.systemPrompt;

    const candidates = [configuredSystem, templateSystem, requestSystem]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (candidates.length === 0) {
      return undefined;
    }

    return candidates.join("\n\n");
  }

  private resolveStructuredSystemPrompt(req: LLMStructuredRequest): string {
    const template = this.templates.get("runtime-plan");
    const strictHint = req.strict === false ? "false" : "true";
    const defaultPrompt = [
      "You generate RuntimePlan JSON for Renderify.",
      "Return only JSON with no markdown or explanations.",
      'Use specVersion exactly as "runtime-plan/v1".',
      "Schema priority: id/version/root/capabilities must be valid.",
      "Do not set root.type to component unless source.code is present with a matching export.",
      'Do not include synthetic source module aliases such as "this-plan-source" in imports, capabilities.allowedModules, or moduleManifest.',
      'Do not use local path aliases such as "@/..." in any import or module URL.',
      'Do not emit wildcard module specifiers such as "https://esm.sh/*".',
      "When using third-party UI libraries, prefer bare npm specifiers (for example @mui/material) over direct CDN URLs.",
      "When third-party UI libraries are unavailable, use plain JSX/HTML components instead of fake CDN paths.",
      'If source.language is jsx/tsx and code uses React-like hooks/imports, set source.runtime to "preact".',
      "For preact source modules, import hooks from preact/compat or preact/hooks (not renderify).",
      `Strict mode: ${strictHint}.`,
    ].join(" ");

    return [this.resolveSystemPrompt(req), template, defaultPrompt]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join("\n\n");
  }

  private buildUserPrompt(req: LLMRequest): string {
    const contextSnippet = formatContext(req.context);
    if (!contextSnippet) {
      return req.prompt;
    }

    return `${req.prompt}\n\nContext:\n${contextSnippet}`;
  }

  private async requestGenerateContent(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GoogleGenerateContentPayload> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in GoogleLLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "Google apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    try {
      return await withTimeoutAbortScope(
        this.options.timeoutMs,
        signal,
        async (timeoutSignal) => {
          const response = await fetchWithReliability({
            fetchImpl,
            input: `${this.options.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(this.options.model)}:generateContent`,
            init: {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify(body),
              signal: timeoutSignal,
            },
            reliability: this.reliability,
            state: this.reliabilityState,
            operationName: "Google request",
          });

          if (!response.ok) {
            const details = await readErrorResponse(response);
            throw new Error(
              `Google request failed (${response.status}): ${details}`,
            );
          }

          const parsed =
            (await response.json()) as GoogleGenerateContentPayload;
          if (parsed.error?.message) {
            throw new Error(`Google error: ${parsed.error.message}`);
          }

          return parsed;
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal?.aborted) {
          throw new Error("Google request aborted by caller");
        }
        throw new Error(
          `Google request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    }
  }

  private extractText(payload: GoogleGenerateContentPayload): string {
    return this.extractTextRaw(payload).trim();
  }

  private extractTextRaw(payload: GoogleGenerateContentPayload): string {
    const candidate = payload.candidates?.[0];
    if (!candidate) {
      return "";
    }

    return (candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  private extractRefusal(
    payload: GoogleGenerateContentPayload,
  ): string | undefined {
    const blockReason = payload.promptFeedback?.blockReason;
    if (typeof blockReason === "string" && blockReason.trim().length > 0) {
      const details = payload.promptFeedback?.blockReasonMessage;
      if (typeof details === "string" && details.trim().length > 0) {
        return `${blockReason.trim()}: ${details.trim()}`;
      }

      return blockReason.trim();
    }

    const finishReason = payload.candidates?.[0]?.finishReason;
    if (
      finishReason === "SAFETY" ||
      finishReason === "RECITATION" ||
      finishReason === "BLOCKLIST" ||
      finishReason === "PROHIBITED_CONTENT" ||
      finishReason === "SPII"
    ) {
      return `finishReason=${finishReason}`;
    }

    return undefined;
  }

  private extractTotalTokens(
    payload: GoogleGenerateContentPayload,
  ): number | undefined {
    const usage = payload.usageMetadata;
    if (!usage) {
      return undefined;
    }

    if (typeof usage.totalTokenCount === "number") {
      return usage.totalTokenCount;
    }

    const prompt = usage.promptTokenCount;
    const candidates = usage.candidatesTokenCount;
    if (typeof prompt !== "number" && typeof candidates !== "number") {
      return undefined;
    }

    return (prompt ?? 0) + (candidates ?? 0);
  }
}
