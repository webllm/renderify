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

export interface OpenAILLMInterpreterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  organization?: string;
  project?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAIUsagePayload {
  total_tokens?: number;
}

interface OpenAIChoicePayload {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    refusal?: string | null;
  };
}

interface OpenAIChatCompletionsPayload {
  id?: string;
  model?: string;
  usage?: OpenAIUsagePayload;
  choices?: OpenAIChoicePayload[];
  error?: {
    message?: string;
  };
}

interface OpenAIStreamChoicePayload {
  delta?: {
    content?: string | Array<{ type?: string; text?: string }>;
    refusal?: string | null;
  };
}

interface OpenAIChatCompletionsStreamPayload {
  id?: string;
  model?: string;
  usage?: OpenAIUsagePayload;
  choices?: OpenAIStreamChoicePayload[];
  error?: {
    message?: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user";
  content: string;
}

interface OpenAIExtractedOutput {
  text: string;
  refusal?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 30000;

const RUNTIME_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["id", "version", "root", "capabilities"],
  properties: {
    specVersion: {
      type: "string",
      minLength: 1,
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
      additionalProperties: true,
    },
    capabilities: {
      type: "object",
      additionalProperties: true,
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

export class OpenAILLMInterpreter implements LLMInterpreter {
  private readonly templates = new Map<string, string>();
  private options: Required<
    Pick<OpenAILLMInterpreterOptions, "baseUrl" | "model" | "timeoutMs">
  > &
    Omit<
      OpenAILLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "fetchImpl"
    > = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    apiKey: undefined,
    organization: undefined,
    project: undefined,
    systemPrompt: undefined,
  };
  private fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAILLMInterpreterOptions = {}) {
    this.configure({ ...options });
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    }
  }

  configure(options: Record<string, unknown>): void {
    const apiKey = pickString(options, "apiKey", "llmApiKey");
    const model = pickString(options, "model", "llmModel");
    const baseUrl = pickString(options, "baseUrl", "llmBaseUrl");
    const organization = pickString(
      options,
      "organization",
      "openaiOrganization",
    );
    const project = pickString(options, "project", "openaiProject");
    const systemPrompt = pickString(options, "systemPrompt");
    const timeoutMs = pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const fetchImpl = pickFetch(options, "fetchImpl");

    this.options = {
      ...this.options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    }
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const payload = await this.requestChatCompletions(
      {
        model: this.options.model,
        messages: this.buildMessages(req),
      },
      req.signal,
    );

    const output = this.extractOutput(payload);
    if (output.refusal) {
      throw new Error(`OpenAI refused request: ${output.refusal}`);
    }

    return {
      text: output.text,
      tokensUsed: payload.usage?.total_tokens,
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
      "Global fetch is unavailable. Provide fetchImpl in OpenAILLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "OpenAI apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
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
        const eventData = event.data;
        if (eventData === "[DONE]") {
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

        let payload: OpenAIChatCompletionsStreamPayload;
        try {
          payload = JSON.parse(eventData) as OpenAIChatCompletionsStreamPayload;
        } catch (error) {
          throw new Error(
            `OpenAI stream chunk parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (payload.error?.message) {
          throw new Error(`OpenAI error: ${payload.error.message}`);
        }

        if (
          typeof payload.model === "string" &&
          payload.model.trim().length > 0
        ) {
          model = payload.model;
        }

        if (
          typeof payload.usage?.total_tokens === "number" &&
          Number.isFinite(payload.usage.total_tokens)
        ) {
          tokensUsed = payload.usage.total_tokens;
        }

        const output = this.extractStreamDelta(payload);
        if (output.refusal) {
          throw new Error(`OpenAI refused request: ${output.refusal}`);
        }

        if (output.text.length === 0) {
          continue;
        }

        aggregatedText += output.text;
        chunkIndex += 1;
        chunks.push({
          delta: output.text,
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
      const response = await fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: this.createHeaders(apiKey),
          body: JSON.stringify({
            model: this.options.model,
            messages: this.buildMessages(req),
            stream: true,
            stream_options: {
              include_usage: true,
            },
          }),
          signal: abortScope.signal,
        },
      );

      if (!response.ok) {
        const details = await readErrorResponse(response);
        throw new Error(
          `OpenAI request failed (${response.status}): ${details}`,
        );
      }

      if (!response.body) {
        throw new Error("OpenAI streaming response body is empty");
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
          throw new Error("OpenAI request aborted by caller");
        }
        throw new Error(
          `OpenAI request timed out after ${this.options.timeoutMs}ms`,
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

    const payload = await this.requestChatCompletions(
      {
        model: this.options.model,
        messages: this.buildMessages({
          ...req,
          systemPrompt: this.resolveStructuredSystemPrompt(req),
        }),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "runtime_plan",
            strict: req.strict !== false,
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
        errors: [`OpenAI refusal: ${output.refusal}`],
        tokensUsed: payload.usage?.total_tokens,
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
        tokensUsed: payload.usage?.total_tokens,
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
        tokensUsed: payload.usage?.total_tokens,
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    if (!isRuntimePlan(parsed.value)) {
      return {
        text: output.text,
        value: parsed.value as T,
        valid: false,
        errors: ["Structured payload is not a valid RuntimePlan"],
        tokensUsed: payload.usage?.total_tokens,
        model: payload.model ?? this.options.model,
        raw: {
          mode: "structured",
          responseId: payload.id,
        },
      };
    }

    return {
      text: output.text,
      value: parsed.value as T,
      valid: true,
      tokensUsed: payload.usage?.total_tokens,
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

  private async requestChatCompletions(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionsPayload> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in OpenAILLMInterpreter options.",
    );
    const apiKey = this.options.apiKey;

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "OpenAI apiKey is missing. Set RENDERIFY_LLM_API_KEY or configure apiKey.",
      );
    }

    try {
      return await withTimeoutAbortScope(
        this.options.timeoutMs,
        signal,
        async (timeoutSignal) => {
          const response = await fetchImpl(
            `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
            {
              method: "POST",
              headers: this.createHeaders(apiKey),
              body: JSON.stringify(body),
              signal: timeoutSignal,
            },
          );

          if (!response.ok) {
            const details = await readErrorResponse(response);
            throw new Error(
              `OpenAI request failed (${response.status}): ${details}`,
            );
          }

          const parsed =
            (await response.json()) as OpenAIChatCompletionsPayload;
          if (parsed.error?.message) {
            throw new Error(`OpenAI error: ${parsed.error.message}`);
          }

          return parsed;
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal?.aborted) {
          throw new Error("OpenAI request aborted by caller");
        }
        throw new Error(
          `OpenAI request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    }
  }

  private buildMessages(req: LLMRequest): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    const templateSystem = this.templates.get("default");
    const promptSystem = req.systemPrompt;
    const configuredSystem = this.options.systemPrompt;

    for (const system of [configuredSystem, templateSystem, promptSystem]) {
      if (typeof system === "string" && system.trim().length > 0) {
        messages.push({
          role: "system",
          content: system.trim(),
        });
      }
    }

    const contextSnippet = formatContext(req.context);
    const prompt = contextSnippet
      ? `${req.prompt}\n\nContext:\n${contextSnippet}`
      : req.prompt;

    messages.push({
      role: "user",
      content: prompt,
    });

    return messages;
  }

  private resolveStructuredSystemPrompt(req: LLMStructuredRequest): string {
    const template = this.templates.get("runtime-plan");
    if (template && template.trim().length > 0) {
      return template;
    }

    const strictHint = req.strict === false ? "false" : "true";
    return [
      "You generate RuntimePlan JSON for Renderify.",
      "Return only JSON with no markdown or explanations.",
      "Schema priority: id/version/root/capabilities must be valid.",
      `Strict mode: ${strictHint}.`,
    ].join(" ");
  }

  private createHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };

    if (this.options.organization) {
      headers["OpenAI-Organization"] = this.options.organization;
    }

    if (this.options.project) {
      headers["OpenAI-Project"] = this.options.project;
    }

    return headers;
  }

  private extractOutput(
    payload: OpenAIChatCompletionsPayload,
  ): OpenAIExtractedOutput {
    const choice = payload.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error("OpenAI response missing assistant choice");
    }

    const refusal = choice.message.refusal;
    if (typeof refusal === "string" && refusal.trim().length > 0) {
      return {
        text: "",
        refusal: refusal.trim(),
      };
    }

    const content = choice.message.content;
    if (typeof content === "string") {
      return {
        text: content.trim(),
      };
    }

    if (Array.isArray(content)) {
      const combined = content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      return {
        text: combined,
      };
    }

    return {
      text: "",
    };
  }

  private extractStreamDelta(
    payload: OpenAIChatCompletionsStreamPayload,
  ): OpenAIExtractedOutput {
    const choices = payload.choices ?? [];
    let text = "";

    for (const choice of choices) {
      const refusal = choice.delta?.refusal;
      if (typeof refusal === "string" && refusal.trim().length > 0) {
        return {
          text: "",
          refusal: refusal.trim(),
        };
      }

      const content = choice.delta?.content;
      if (typeof content === "string") {
        text += content;
        continue;
      }

      if (Array.isArray(content)) {
        text += content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("");
      }
    }

    return {
      text,
    };
  }
}
