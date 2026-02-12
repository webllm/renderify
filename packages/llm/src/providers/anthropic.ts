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
  createTimeoutAbortScope,
  formatContext,
  pickFetch,
  pickPositiveInt,
  pickString,
  readErrorResponse,
  resolveFetch,
  tryParseJson,
  withTimeoutAbortScope,
} from "./shared";

export interface AnthropicLLMInterpreterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  version?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

interface AnthropicContentPart {
  type?: string;
  text?: string;
}

interface AnthropicMessagesPayload {
  id?: string;
  model?: string;
  content?: AnthropicContentPart[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface AnthropicStreamPayload {
  type?: string;
  error?: {
    message?: string;
  };
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  delta?: {
    text?: string;
    stop_reason?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicLLMInterpreter implements LLMInterpreter {
  private readonly templates = new Map<string, string>();
  private options: Required<
    Pick<
      AnthropicLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "maxTokens" | "version"
    >
  > &
    Omit<
      AnthropicLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "maxTokens" | "version" | "fetchImpl"
    > = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTokens: DEFAULT_MAX_TOKENS,
    version: DEFAULT_ANTHROPIC_VERSION,
    apiKey: undefined,
    systemPrompt: undefined,
  };
  private fetchImpl: typeof fetch | undefined;

  constructor(options: AnthropicLLMInterpreterOptions = {}) {
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
    const version = pickString(options, "version", "anthropicVersion");
    const timeoutMs = pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const maxTokens = pickPositiveInt(options, "maxTokens");
    const fetchImpl = pickFetch(options, "fetchImpl");

    this.options = {
      ...this.options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };

    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    }
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const payload = await this.requestMessages(
      {
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: this.resolveSystemPrompt(req),
        messages: [
          {
            role: "user",
            content: this.buildUserPrompt(req),
          },
        ],
      },
      req.signal,
    );

    const text = this.extractText(payload);

    return {
      text,
      tokensUsed: this.extractTotalTokens(payload),
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
      "Global fetch is unavailable. Provide fetchImpl in AnthropicLLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "Anthropic apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    const abortScope = createTimeoutAbortScope(
      this.options.timeoutMs,
      req.signal,
    );

    let aggregatedText = "";
    let chunkIndex = 0;
    let tokensUsed: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let model = this.options.model;
    let responseId: string | undefined;
    let doneEmitted = false;

    const processEvents = (
      events: Array<{ event?: string; data: string }>,
    ): Array<LLMResponseStreamChunk> => {
      const chunks: LLMResponseStreamChunk[] = [];

      for (const event of events) {
        if (event.data === "[DONE]" || event.event === "message_stop") {
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
                responseId,
                done: true,
                event: event.event ?? "done",
              },
            });
          }
          continue;
        }

        let payload: AnthropicStreamPayload;
        try {
          payload = JSON.parse(event.data) as AnthropicStreamPayload;
        } catch (error) {
          throw new Error(
            `Anthropic stream chunk parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (payload.error?.message) {
          throw new Error(`Anthropic error: ${payload.error.message}`);
        }

        if (typeof payload.message?.id === "string") {
          responseId = payload.message.id;
        }

        if (
          typeof payload.message?.model === "string" &&
          payload.message.model.trim().length > 0
        ) {
          model = payload.message.model;
        }

        const usageInput = payload.message?.usage?.input_tokens;
        const usageOutput =
          payload.message?.usage?.output_tokens ?? payload.usage?.output_tokens;
        if (typeof usageInput === "number") {
          inputTokens = usageInput;
        }
        if (typeof usageOutput === "number") {
          outputTokens = usageOutput;
        }
        if (
          typeof inputTokens === "number" ||
          typeof outputTokens === "number"
        ) {
          tokensUsed = (inputTokens ?? 0) + (outputTokens ?? 0);
        }

        const deltaText =
          payload.type === "content_block_delta" &&
          typeof payload.delta?.text === "string"
            ? payload.delta.text
            : "";

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
            responseId,
            event: event.event ?? payload.type,
            chunk: payload,
          },
        });
      }

      return chunks;
    };

    try {
      const response = await fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, "")}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": this.options.version,
          },
          body: JSON.stringify({
            model: this.options.model,
            max_tokens: this.options.maxTokens,
            system: this.resolveSystemPrompt(req),
            stream: true,
            messages: [
              {
                role: "user",
                content: this.buildUserPrompt(req),
              },
            ],
          }),
          signal: abortScope.signal,
        },
      );

      if (!response.ok) {
        const details = await readErrorResponse(response);
        throw new Error(
          `Anthropic request failed (${response.status}): ${details}`,
        );
      }

      if (!response.body) {
        throw new Error("Anthropic streaming response body is empty");
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
            responseId,
            done: true,
            reason: "eof",
          },
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (req.signal?.aborted) {
          throw new Error("Anthropic request aborted by caller");
        }
        throw new Error(
          `Anthropic request timed out after ${this.options.timeoutMs}ms`,
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

    const payload = await this.requestMessages(
      {
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: this.resolveStructuredSystemPrompt(req),
        messages: [
          {
            role: "user",
            content: this.buildUserPrompt(req),
          },
        ],
      },
      req.signal,
    );

    const text = this.extractText(payload);

    if (text.trim().length === 0) {
      return {
        text,
        valid: false,
        errors: ["Structured response content is empty"],
        tokensUsed: this.extractTotalTokens(payload),
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
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
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
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
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    return {
      text,
      value: parsed.value as T,
      valid: true,
      tokensUsed: this.extractTotalTokens(payload),
      model: payload.model ?? this.options.model,
      raw: {
        mode: "structured",
        responseId: payload.id,
      },
    };
  }

  setPromptTemplate(templateName: string, templateContent: string): void {
    this.templates.set(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.templates.get(templateName);
  }

  private resolveSystemPrompt(req: LLMRequest): string | undefined {
    const templateSystem = this.templates.get("default");
    const configuredSystem = this.options.systemPrompt;
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
      "Schema priority: id/version/root/capabilities must be valid.",
      `Strict mode: ${strictHint}.`,
    ].join(" ");

    const combined = [this.resolveSystemPrompt(req), template, defaultPrompt]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join("\n\n");

    return combined;
  }

  private buildUserPrompt(req: LLMRequest): string {
    const contextSnippet = formatContext(req.context);
    if (!contextSnippet) {
      return req.prompt;
    }

    return `${req.prompt}\n\nContext:\n${contextSnippet}`;
  }

  private async requestMessages(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesPayload> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in AnthropicLLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "Anthropic apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    try {
      return await withTimeoutAbortScope(
        this.options.timeoutMs,
        signal,
        async (timeoutSignal) => {
          const response = await fetchImpl(
            `${this.options.baseUrl.replace(/\/$/, "")}/messages`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": this.options.version,
              },
              body: JSON.stringify(body),
              signal: timeoutSignal,
            },
          );

          if (!response.ok) {
            const details = await readErrorResponse(response);
            throw new Error(
              `Anthropic request failed (${response.status}): ${details}`,
            );
          }

          const parsed = (await response.json()) as AnthropicMessagesPayload;
          if (parsed.error?.message) {
            throw new Error(`Anthropic error: ${parsed.error.message}`);
          }

          return parsed;
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal?.aborted) {
          throw new Error("Anthropic request aborted by caller");
        }
        throw new Error(
          `Anthropic request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    }
  }

  private extractText(payload: AnthropicMessagesPayload): string {
    const content = payload.content;
    if (!Array.isArray(content) || content.length === 0) {
      return "";
    }

    return content
      .map((part) =>
        part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("")
      .trim();
  }

  private extractTotalTokens(
    payload: AnthropicMessagesPayload,
  ): number | undefined {
    const input = payload.usage?.input_tokens;
    const output = payload.usage?.output_tokens;

    if (typeof input !== "number" && typeof output !== "number") {
      return undefined;
    }

    return (input ?? 0) + (output ?? 0);
  }
}
