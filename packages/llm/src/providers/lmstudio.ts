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
    const apiKey = pickConfiguredValue(options, "apiKey", "llmApiKey");
    const baseUrl = pickConfiguredValue(options, "baseUrl", "llmBaseUrl");
    const model = pickConfiguredValue(options, "model", "llmModel");

    super.configure({
      ...options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }
}

function pickConfiguredValue(
  options: Record<string, unknown>,
  directKey: string,
  genericKey: string,
): string | undefined {
  const direct = options[directKey];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  const generic = options[genericKey];
  return typeof generic === "string" && generic.trim().length > 0
    ? generic.trim()
    : undefined;
}

function resolveValue(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}
