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
  generateStructuredResponse?<T = unknown>(
    req: LLMStructuredRequest,
  ): Promise<LLMStructuredResponse<T>>;
  setPromptTemplate(templateName: string, templateContent: string): void;
  getPromptTemplate(templateName: string): string | undefined;
}

export class DefaultLLMInterpreter implements LLMInterpreter {
  private templates: Map<string, string> = new Map();
  private config: Record<string, unknown> = {};

  configure(options: Record<string, unknown>) {
    this.config = { ...this.config, ...options };
  }

  async generateResponse(req: LLMRequest): Promise<LLMResponse> {
    const basePrompt = this.templates.get("default") ?? "";
    const contextualHint =
      req.context && Object.keys(req.context).length > 0
        ? `\nContextKeys: ${Object.keys(req.context).join(",")}`
        : "";

    const finalPrompt = `${basePrompt}\nUserInput: ${req.prompt}${contextualHint}`;

    return {
      text: `Generated runtime description for: ${req.prompt}\n${finalPrompt}`,
      tokensUsed: finalPrompt.length,
      model: String(this.config.model ?? "mock-llm"),
      raw: {
        mode: "text",
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
        model: String(this.config.model ?? "mock-llm"),
      };
    }

    if (this.config.mockStructuredInvalid === true) {
      return {
        text: '{"invalid":true}',
        valid: false,
        errors: ["mockStructuredInvalid=true"],
        tokensUsed: 16,
        model: String(this.config.model ?? "mock-llm"),
        raw: {
          mode: "structured",
          mocked: true,
        },
      };
    }

    const candidate = this.buildRuntimePlanCandidate(req);
    const text = JSON.stringify(candidate);

    return {
      text,
      value: candidate as T,
      valid: true,
      tokensUsed: text.length,
      model: String(this.config.model ?? "mock-llm"),
      raw: {
        mode: "structured",
      },
    };
  }

  setPromptTemplate(templateName: string, templateContent: string) {
    this.templates.set(templateName, templateContent);
  }

  getPromptTemplate(templateName: string): string | undefined {
    return this.templates.get(templateName);
  }

  private buildRuntimePlanCandidate(
    req: LLMStructuredRequest,
  ): Record<string, unknown> {
    const specVersion = "runtime-plan/v1";
    const prompt =
      req.prompt.trim().length > 0 ? req.prompt.trim() : "Untitled";
    const planId = `plan_${Date.now().toString(36)}`;

    if (/\bcounter\b/i.test(prompt)) {
      return {
        specVersion,
        id: planId,
        version: 1,
        capabilities: {
          domWrite: true,
        },
        state: {
          initial: {
            count: 0,
          },
          transitions: {
            increment: [{ type: "increment", path: "count", by: 1 }],
          },
        },
        root: {
          type: "element",
          tag: "section",
          children: [
            {
              type: "element",
              tag: "h2",
              children: [{ type: "text", value: prompt }],
            },
            {
              type: "element",
              tag: "p",
              children: [{ type: "text", value: "Count={{state.count}}" }],
            },
          ],
        },
        metadata: {
          sourcePrompt: prompt,
          sourceModel: String(this.config.model ?? "mock-llm"),
          tags: ["structured", "counter"],
        },
      };
    }

    return {
      specVersion,
      id: planId,
      version: 1,
      capabilities: {
        domWrite: true,
      },
      root: {
        type: "element",
        tag: "section",
        children: [
          {
            type: "element",
            tag: "h1",
            children: [{ type: "text", value: prompt }],
          },
          {
            type: "element",
            tag: "p",
            children: [{ type: "text", value: "Structured runtime response" }],
          },
        ],
      },
      metadata: {
        sourcePrompt: prompt,
        sourceModel: String(this.config.model ?? "mock-llm"),
        tags: ["structured"],
      },
    };
  }
}
