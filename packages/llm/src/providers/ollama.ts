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

export interface OllamaLLMInterpreterOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

interface OllamaGeneratePayload {
  model?: string;
  response?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5-coder:7b";
const DEFAULT_TIMEOUT_MS = 30000;

export class OllamaLLMInterpreter implements LLMInterpreter {
  private readonly templates = new Map<string, string>();
  private options: Required<
    Pick<OllamaLLMInterpreterOptions, "baseUrl" | "model" | "timeoutMs">
  > &
    Omit<
      OllamaLLMInterpreterOptions,
      "baseUrl" | "model" | "timeoutMs" | "fetchImpl"
    > = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepAlive: undefined,
    systemPrompt: undefined,
  };
  private fetchImpl: typeof fetch | undefined;

  constructor(options: OllamaLLMInterpreterOptions = {}) {
    this.configure({ ...options });
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    }
  }

  configure(options: Record<string, unknown>): void {
    const model = pickString(options, "model", "llmModel");
    const baseUrl = pickString(options, "baseUrl", "llmBaseUrl");
    const systemPrompt = pickString(options, "systemPrompt");
    const keepAlive = pickString(options, "keepAlive", "ollamaKeepAlive");
    const timeoutMs = pickPositiveInt(
      options,
      "timeoutMs",
      "llmRequestTimeoutMs",
    );
    const fetchImpl = pickFetch(options, "fetchImpl");

    this.options = {
      ...this.options,
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(keepAlive !== undefined ? { keepAlive } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    }
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const payload = await this.requestGenerate(
      {
        model: this.options.model,
        prompt: this.buildPrompt(req),
        stream: false,
        ...(this.options.keepAlive
          ? { keep_alive: this.options.keepAlive }
          : {}),
      },
      req.signal,
    );

    if (payload.error) {
      throw new Error(`Ollama error: ${payload.error}`);
    }

    const text = typeof payload.response === "string" ? payload.response : "";

    return {
      text,
      tokensUsed: this.extractTotalTokens(payload),
      model: payload.model ?? this.options.model,
      raw: {
        mode: "text",
        done: payload.done,
        doneReason: payload.done_reason,
      },
    };
  }

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in OllamaLLMInterpreter options.",
    );

    const abortScope = createTimeoutAbortScope(
      this.options.timeoutMs,
      req.signal,
    );

    let aggregatedText = "";
    let chunkIndex = 0;
    let tokensUsed: number | undefined;
    let model = this.options.model;
    let doneEmitted = false;

    const processPayload = (
      payload: OllamaGeneratePayload,
    ): LLMResponseStreamChunk[] => {
      const chunks: LLMResponseStreamChunk[] = [];
      if (payload.error) {
        throw new Error(`Ollama error: ${payload.error}`);
      }

      if (
        typeof payload.model === "string" &&
        payload.model.trim().length > 0
      ) {
        model = payload.model;
      }

      const tokenCount = this.extractTotalTokens(payload);
      if (typeof tokenCount === "number") {
        tokensUsed = tokenCount;
      }

      const delta =
        typeof payload.response === "string" ? payload.response : "";
      if (delta.length > 0) {
        aggregatedText += delta;
        chunkIndex += 1;
        chunks.push({
          delta,
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

      if (payload.done && !doneEmitted) {
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
            doneReason: payload.done_reason,
          },
        });
      }

      return chunks;
    };

    try {
      const response = await fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, "")}/api/generate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            prompt: this.buildPrompt(req),
            stream: true,
            ...(this.options.keepAlive
              ? { keep_alive: this.options.keepAlive }
              : {}),
          }),
          signal: abortScope.signal,
        },
      );

      if (!response.ok) {
        const details = await readErrorResponse(response);
        throw new Error(
          `Ollama request failed (${response.status}): ${details}`,
        );
      }

      if (!response.body) {
        throw new Error("Ollama streaming response body is empty");
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

        const parsed = consumeNdjsonPayloads(buffer);
        buffer = parsed.remaining;

        for (const payload of parsed.payloads) {
          for (const chunk of processPayload(payload)) {
            yield chunk;
          }
        }
      }

      buffer += decoder.decode();
      const finalParsed = consumeNdjsonPayloads(buffer, true);
      for (const payload of finalParsed.payloads) {
        for (const chunk of processPayload(payload)) {
          yield chunk;
        }
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
            doneReason: "eof",
          },
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (req.signal?.aborted) {
          throw new Error("Ollama request aborted by caller");
        }
        throw new Error(
          `Ollama request timed out after ${this.options.timeoutMs}ms`,
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

    const response = await this.generateResponse({
      prompt: `${req.prompt}\n\nReturn valid JSON only.`,
      context: req.context,
      systemPrompt: req.systemPrompt,
      signal: req.signal,
    });

    const parsed = tryParseJson(response.text);
    if (!parsed.ok) {
      return {
        text: response.text,
        valid: false,
        errors: [`Structured JSON parse failed: ${parsed.error}`],
        tokensUsed: response.tokensUsed,
        model: response.model,
        raw: {
          mode: "structured",
          source: response.raw,
        },
      };
    }

    if (!isRuntimePlan(parsed.value)) {
      return {
        text: response.text,
        valid: false,
        errors: ["Structured response is not a valid RuntimePlan"],
        tokensUsed: response.tokensUsed,
        model: response.model,
        raw: {
          mode: "structured",
          source: response.raw,
        },
      };
    }

    return {
      text: response.text,
      value: parsed.value as T,
      valid: true,
      tokensUsed: response.tokensUsed,
      model: response.model,
      raw: {
        mode: "structured",
        source: response.raw,
      },
    };
  }

  setPromptTemplate(templateName: string, templateContent: string): void {
    this.templates.set(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.templates.get(templateName);
  }

  private buildPrompt(req: LLMRequest): string {
    const systemPrompt = this.resolveSystemPrompt(req);
    const context = formatContext(req.context);
    const sections = [
      systemPrompt,
      context ? `Context: ${context}` : undefined,
      req.prompt,
    ]
      .filter(
        (section): section is string =>
          typeof section === "string" && section.trim().length > 0,
      )
      .map((section) => section.trim());

    return sections.join("\n\n");
  }

  private resolveSystemPrompt(req: LLMRequest): string | undefined {
    if (
      typeof req.systemPrompt === "string" &&
      req.systemPrompt.trim().length > 0
    ) {
      return req.systemPrompt.trim();
    }

    if (
      typeof this.options.systemPrompt === "string" &&
      this.options.systemPrompt.trim().length > 0
    ) {
      return this.options.systemPrompt.trim();
    }

    const template = this.templates.get("default");
    if (typeof template === "string" && template.trim().length > 0) {
      return template.trim();
    }

    return undefined;
  }

  private async requestGenerate(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OllamaGeneratePayload> {
    const fetchImpl = resolveFetch(
      this.fetchImpl,
      "Global fetch is unavailable. Provide fetchImpl in OllamaLLMInterpreter options.",
    );

    try {
      return await withTimeoutAbortScope(
        this.options.timeoutMs,
        signal,
        async (scopedSignal) => {
          const response = await fetchImpl(
            `${this.options.baseUrl.replace(/\/$/, "")}/api/generate`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              signal: scopedSignal,
            },
          );

          if (!response.ok) {
            const details = await readErrorResponse(response);
            throw new Error(
              `Ollama request failed (${response.status}): ${details}`,
            );
          }

          const payload = (await response.json()) as OllamaGeneratePayload;
          if (payload.error) {
            throw new Error(`Ollama error: ${payload.error}`);
          }

          return payload;
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal?.aborted) {
          throw new Error("Ollama request aborted by caller");
        }
        throw new Error(
          `Ollama request timed out after ${this.options.timeoutMs}ms`,
        );
      }
      throw error;
    }
  }

  private extractTotalTokens(
    payload: OllamaGeneratePayload,
  ): number | undefined {
    const promptTokens =
      typeof payload.prompt_eval_count === "number"
        ? payload.prompt_eval_count
        : 0;
    const completionTokens =
      typeof payload.eval_count === "number" ? payload.eval_count : 0;

    const total = promptTokens + completionTokens;
    return total > 0 ? total : undefined;
  }
}

function consumeNdjsonPayloads(
  buffer: string,
  flush = false,
): { payloads: OllamaGeneratePayload[]; remaining: string } {
  const payloads: OllamaGeneratePayload[] = [];
  const lines = buffer.split(/\r?\n/);
  const completeLineCount = flush
    ? lines.length
    : Math.max(0, lines.length - 1);

  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }

    try {
      payloads.push(JSON.parse(line) as OllamaGeneratePayload);
    } catch (error) {
      throw new Error(
        `Ollama stream chunk parse failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const remaining = flush ? "" : (lines.at(-1) ?? "");
  return {
    payloads,
    remaining,
  };
}
