import type {
  LLMInterpreter,
  LLMRequest,
  LLMResponse,
  LLMStructuredRequest,
  LLMStructuredResponse,
} from "@renderify/core";
import { isRuntimePlan } from "@renderify/ir";

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
    const apiKey = this.pickString(options, "apiKey", "llmApiKey");
    const model = this.pickString(options, "model", "llmModel");
    const baseUrl = this.pickString(options, "baseUrl", "llmBaseUrl");
    const systemPrompt = this.pickString(options, "systemPrompt");
    const version = this.pickString(options, "version", "anthropicVersion");
    const timeoutMs = this.pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const maxTokens = this.pickPositiveInt(options, "maxTokens");
    const fetchImpl = this.pickFetch(options, "fetchImpl");

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
    const payload = await this.requestMessages({
      model: this.options.model,
      max_tokens: this.options.maxTokens,
      system: this.resolveSystemPrompt(req),
      messages: [
        {
          role: "user",
          content: this.buildUserPrompt(req),
        },
      ],
    });

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

    const payload = await this.requestMessages({
      model: this.options.model,
      max_tokens: this.options.maxTokens,
      system: this.resolveStructuredSystemPrompt(req),
      messages: [
        {
          role: "user",
          content: this.buildUserPrompt(req),
        },
      ],
    });

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

    const parsed = this.tryParseJson(text);
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
    const contextSnippet = this.formatContext(req.context);
    if (!contextSnippet) {
      return req.prompt;
    }

    return `${req.prompt}\n\nContext:\n${contextSnippet}`;
  }

  private formatContext(context: Record<string, unknown> | undefined): string {
    if (!context || Object.keys(context).length === 0) {
      return "";
    }

    try {
      return JSON.stringify(context);
    } catch {
      return "";
    }
  }

  private async requestMessages(
    body: Record<string, unknown>,
  ): Promise<AnthropicMessagesPayload> {
    const fetchImpl = this.resolveFetch();
    const apiKey = this.options.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "Anthropic apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);

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
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const details = await this.readErrorResponse(response);
        throw new Error(
          `Anthropic request failed (${response.status}): ${details}`,
        );
      }

      const parsed = (await response.json()) as AnthropicMessagesPayload;
      if (parsed.error?.message) {
        throw new Error(`Anthropic error: ${parsed.error.message}`);
      }

      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Anthropic request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
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

  private tryParseJson(
    raw: string,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const payload = fenced ? fenced[1] : raw;

    try {
      return {
        ok: true,
        value: JSON.parse(payload) as unknown,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readErrorResponse(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (body.error?.message) {
        return body.error.message;
      }
      return JSON.stringify(body);
    } catch {
      try {
        return await response.text();
      } catch {
        return "unknown error";
      }
    }
  }

  private resolveFetch(): typeof fetch {
    if (this.fetchImpl) {
      return this.fetchImpl;
    }

    if (typeof globalThis.fetch === "function") {
      return globalThis.fetch.bind(globalThis);
    }

    throw new Error(
      "Global fetch is unavailable. Provide fetchImpl in AnthropicLLMInterpreter options.",
    );
  }

  private pickString(
    source: Record<string, unknown>,
    ...keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return undefined;
  }

  private pickPositiveInt(
    source: Record<string, unknown>,
    ...keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }

      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          return Math.floor(parsed);
        }
      }
    }

    return undefined;
  }

  private pickFetch(
    source: Record<string, unknown>,
    key: string,
  ): typeof fetch | undefined {
    const value = source[key];
    if (typeof value === "function") {
      return value as typeof fetch;
    }

    return undefined;
  }
}
