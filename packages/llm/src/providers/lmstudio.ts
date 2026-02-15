import {
  OpenAILLMInterpreter,
  type OpenAILLMInterpreterOptions,
} from "./openai";

export interface LMStudioLLMInterpreterOptions
  extends OpenAILLMInterpreterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_API_KEY = "lm-studio";
const DEFAULT_MODEL = "qwen2.5-coder-7b-instruct";

export class LMStudioLLMInterpreter extends OpenAILLMInterpreter {
  constructor(options: LMStudioLLMInterpreterOptions = {}) {
    super({
      ...options,
      apiKey: resolveValue(options.apiKey, DEFAULT_API_KEY),
      baseUrl: resolveValue(options.baseUrl, DEFAULT_BASE_URL),
      model: resolveValue(options.model, DEFAULT_MODEL),
    });
  }

  configure(options: Record<string, unknown>): void {
    super.configure({
      ...options,
      apiKey: resolveValue(
        typeof options.apiKey === "string" ? options.apiKey : undefined,
        DEFAULT_API_KEY,
      ),
      baseUrl: resolveValue(
        typeof options.baseUrl === "string" ? options.baseUrl : undefined,
        DEFAULT_BASE_URL,
      ),
      model: resolveValue(
        typeof options.model === "string" ? options.model : undefined,
        DEFAULT_MODEL,
      ),
    });
  }
}

function resolveValue(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}
