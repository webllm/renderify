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

  async *generateResponseStream(
    req: LLMRequest,
  ): AsyncIterable<LLMResponseStreamChunk> {
    const response = await this.generateResponse(req);
    const fullText = response.text;
    const chunkSize = this.resolveChunkSize();

    if (fullText.length === 0) {
      yield {
        delta: "",
        text: "",
        done: true,
        index: 0,
        tokensUsed: response.tokensUsed,
        model: response.model,
        raw: {
          mode: "text-stream",
          source: response.raw,
        },
      };
      return;
    }

    let index = 0;
    for (let offset = 0; offset < fullText.length; offset += chunkSize) {
      const delta = fullText.slice(offset, offset + chunkSize);
      index += 1;

      yield {
        delta,
        text: fullText.slice(0, offset + delta.length),
        done: offset + delta.length >= fullText.length,
        index,
        tokensUsed: response.tokensUsed,
        model: response.model,
        raw: {
          mode: "text-stream",
          source: response.raw,
        },
      };
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

    if (/\b(dashboard|analytics|chart|kpi)\b/i.test(prompt)) {
      const imports = ["preact", "preact/hooks", "recharts"];
      const sourceCode = [
        'import { h } from "preact";',
        'import { useMemo, useState } from "preact/hooks";',
        "import {",
        "  ResponsiveContainer,",
        "  BarChart,",
        "  Bar,",
        "  XAxis,",
        "  YAxis,",
        "  CartesianGrid,",
        "  Tooltip,",
        "  Legend,",
        '} from "recharts";',
        "",
        "export default function Dashboard({ state }) {",
        '  const [metric, setMetric] = useState("revenue");',
        "  const dataset = useMemo(",
        "    () => [",
        '      { name: "Mon", revenue: 120, users: 42 },',
        '      { name: "Tue", revenue: 188, users: 59 },',
        '      { name: "Wed", revenue: 164, users: 54 },',
        '      { name: "Thu", revenue: 205, users: 71 },',
        '      { name: "Fri", revenue: 242, users: 88 },',
        "    ],",
        "    []",
        "  );",
        "",
        "  return (",
        '    <section style={{ padding: "12px", fontFamily: "ui-sans-serif, system-ui" }}>',
        `      <h2 style={{ marginTop: 0 }}>${prompt.replace(/`/g, "")}</h2>`,
        '      <p style={{ color: "#475569" }}>Runtime TSX + JSPM + Preact hooks</p>',
        '      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>',
        '        <button type="button" onClick={() => setMetric("revenue")}>Revenue</button>',
        '        <button type="button" onClick={() => setMetric("users")}>Users</button>',
        "      </div>",
        '      <div style={{ width: "100%", height: 260 }}>',
        "        <ResponsiveContainer>",
        "          <BarChart data={dataset}>",
        '            <CartesianGrid strokeDasharray="3 3" />',
        '            <XAxis dataKey="name" />',
        "            <YAxis />",
        "            <Tooltip />",
        "            <Legend />",
        '            <Bar dataKey={metric} fill={metric === "revenue" ? "#0f766e" : "#1d4ed8"} />',
        "          </BarChart>",
        "        </ResponsiveContainer>",
        "      </div>",
        "      <p style={{ marginBottom: 0 }}>Selected metric: {metric} / server count: {state?.count ?? 0}</p>",
        "    </section>",
        "  );",
        "}",
      ].join("\n");

      return {
        specVersion,
        id: planId,
        version: 1,
        capabilities: {
          domWrite: true,
          allowedModules: imports,
          maxExecutionMs: 3000,
        },
        imports,
        moduleManifest: {
          preact: {
            resolvedUrl:
              "https://ga.jspm.io/npm:preact@10.28.3/dist/preact.module.js",
            signer: "mock-llm",
            version: "10.28.3",
          },
          "preact/hooks": {
            resolvedUrl:
              "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js",
            signer: "mock-llm",
            version: "10.28.3",
          },
          recharts: {
            resolvedUrl: "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
            signer: "mock-llm",
            version: "3.3.0",
          },
        },
        state: {
          initial: {
            count: 7,
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
              type: "text",
              value: "Streaming dashboard is rendering...",
            },
          ],
        },
        source: {
          language: "tsx",
          runtime: "preact",
          exportName: "default",
          code: sourceCode,
        },
        metadata: {
          sourcePrompt: prompt,
          sourceModel: String(this.config.model ?? "mock-llm"),
          tags: ["structured", "dashboard", "preact", "recharts"],
        },
      };
    }

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

  private resolveChunkSize(): number {
    const configured = this.config.streamChunkSize;
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.max(8, Math.floor(configured));
    }

    return 96;
  }
}
