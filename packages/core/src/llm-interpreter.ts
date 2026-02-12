export interface LLMRequest {
  prompt: string;
  context?: Record<string, unknown>;
  systemPrompt?: string;
}

export interface LLMResponse {
  text: string;
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

export interface LLMResponseStreamChunk {
  delta: string;
  text: string;
  done: boolean;
  index: number;
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

export interface LLMStructuredRequest extends LLMRequest {
  format: "runtime-plan";
  strict?: boolean;
}

export interface LLMStructuredResponse<T = unknown> {
  text: string;
  value?: T;
  valid: boolean;
  errors?: string[];
  tokensUsed?: number;
  model?: string;
  raw?: unknown;
}

export interface LLMInterpreter {
  configure(options: Record<string, unknown>): void;
  generateResponse(req: LLMRequest): Promise<LLMResponse>;
  generateResponseStream?(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk>;
  generateStructuredResponse?<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>>;
  setPromptTemplate(templateName: string, templateContent: string): void;
  getPromptTemplate(templateName: string): string | undefined;
}
