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

const MAX_API_ERROR_BODY_BYTES = 64 * 1024;
const TRUNCATED_API_ERROR_SUFFIX = "… [truncated]";

export class DefaultApiIntegration implements ApiIntegration {
  private readonly apis: Map<string, ApiDefinition> = new Map();

  registerApi(api: ApiDefinition): void {
    this.apis.set(api.name, cloneApiDefinition(api));
  }

  listApis(): ApiDefinition[] {
    return [...this.apis.values()].map(cloneApiDefinition);
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
        const bodyText = await readBoundedErrorBody(
          response,
          controller?.signal,
        );
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

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      query.set(key, String(value));
    }

    if (query.size === 0) {
      return api.endpoint;
    }

    if (this.isAbsoluteUrl(api.endpoint)) {
      const url = new URL(api.endpoint);
      for (const [key, value] of query.entries()) {
        url.searchParams.set(key, value);
      }
      return url.toString();
    }

    return this.appendQueryToRelativeEndpoint(api.endpoint, query.toString());
  }

  private isAbsoluteUrl(endpoint: string): boolean {
    try {
      const parsed = new URL(endpoint);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private appendQueryToRelativeEndpoint(
    endpoint: string,
    query: string,
  ): string {
    const hashIndex = endpoint.indexOf("#");
    const base = hashIndex >= 0 ? endpoint.slice(0, hashIndex) : endpoint;
    const hash = hashIndex >= 0 ? endpoint.slice(hashIndex) : "";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}${query}${hash}`;
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

function cloneApiDefinition(api: ApiDefinition): ApiDefinition {
  return {
    ...api,
    ...(api.headers ? { headers: { ...api.headers } } : {}),
  };
}

async function readBoundedErrorBody(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    return response.statusText;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytesRead = 0;
  let reachedEnd = false;
  let truncated = false;
  let abortHandler: (() => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = () => reject(resolveAbortReason(signal));
    if (signal?.aborted) {
      rejectFromSignal();
      return;
    }
    abortHandler = rejectFromSignal;
    signal?.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    while (bytesRead < MAX_API_ERROR_BODY_BYTES) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) {
        reachedEnd = true;
        output += decoder.decode();
        break;
      }

      if (!value || value.length === 0) {
        continue;
      }

      const remaining = MAX_API_ERROR_BODY_BYTES - bytesRead;
      const accepted = value.subarray(0, remaining);
      bytesRead += accepted.length;
      output += decoder.decode(accepted, { stream: true });

      if (
        accepted.length < value.length ||
        bytesRead >= MAX_API_ERROR_BODY_BYTES
      ) {
        truncated = true;
        output += decoder.decode();
        break;
      }
    }
  } finally {
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
    if (!reachedEnd) {
      void reader.cancel().catch(() => undefined);
    }
  }

  return truncated ? `${output}${TRUNCATED_API_ERROR_SUFFIX}` : output;
}

function resolveAbortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("API request aborted");
  error.name = "AbortError";
  return error;
}
