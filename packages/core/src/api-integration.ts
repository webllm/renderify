export interface ApiDefinition {
  name: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApiIntegration {
  registerApi(api: ApiDefinition): void;
  listApis(): ApiDefinition[];
  callApi<TResponse = unknown>(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<TResponse>;
}

export class DefaultApiIntegration implements ApiIntegration {
  private readonly apis: Map<string, ApiDefinition> = new Map();

  registerApi(api: ApiDefinition): void {
    this.apis.set(api.name, api);
  }

  listApis(): ApiDefinition[] {
    return [...this.apis.values()];
  }

  async callApi<TResponse = unknown>(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const api = this.apis.get(name);
    if (!api) {
      throw new Error(`API not found: ${name}`);
    }

    const controller =
      typeof AbortController !== "undefined"
        ? new AbortController()
        : undefined;
    const timeout = this.createTimeout(controller, api.timeoutMs ?? 10_000);

    try {
      const url = this.buildUrl(api, params);
      const init: RequestInit = {
        method: api.method,
        headers: {
          "content-type": "application/json",
          ...(api.headers ?? {}),
        },
        signal: controller?.signal,
      };

      if (api.method !== "GET" && api.method !== "DELETE" && params) {
        init.body = JSON.stringify(params);
      }

      const response = await fetch(url, init);
      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(
          `API ${name} failed with ${response.status}: ${bodyText}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as TResponse;
      }

      return (await response.text()) as TResponse;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private buildUrl(
    api: ApiDefinition,
    params?: Record<string, unknown>,
  ): string {
    if (!params || (api.method !== "GET" && api.method !== "DELETE")) {
      return api.endpoint;
    }

    const url = new URL(api.endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private createTimeout(
    controller: AbortController | undefined,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> | undefined {
    if (!controller || timeoutMs <= 0) {
      return undefined;
    }

    return setTimeout(() => controller.abort(), timeoutMs);
  }
}
