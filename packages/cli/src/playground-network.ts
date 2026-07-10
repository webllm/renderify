import type { IncomingHttpHeaders, Server } from "node:http";

export const DEFAULT_PLAYGROUND_HOST = "127.0.0.1";

export function normalizePlaygroundHost(rawValue: string): string {
  const host = rawValue.trim();
  if (host.length === 0) {
    throw new Error("Playground host cannot be empty");
  }

  return host;
}

export function resolvePlaygroundHost(
  cliHost?: string,
  environmentHost?: string,
): string {
  if (cliHost !== undefined) {
    return normalizePlaygroundHost(cliHost);
  }
  if (environmentHost !== undefined && environmentHost.trim().length > 0) {
    return normalizePlaygroundHost(environmentHost);
  }

  return DEFAULT_PLAYGROUND_HOST;
}

export function formatPlaygroundUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function getPlaygroundMutationRejectionReason(
  headers: IncomingHttpHeaders,
): string | undefined {
  const fetchSite = readSingleHeader(headers["sec-fetch-site"]);
  if (!fetchSite.valid) {
    return "Malformed Sec-Fetch-Site header";
  }
  if (fetchSite.value?.toLowerCase() === "cross-site") {
    return "Cross-site browser requests are not allowed";
  }

  const origin = readSingleHeader(headers.origin);
  const referer = readSingleHeader(headers.referer);
  if (!origin.valid || !referer.valid) {
    return "Malformed request provenance header";
  }

  // Non-browser clients do not normally send Origin/Referer. Keep the local
  // HTTP API usable from curl and SDKs; browser cross-site writes carry Origin
  // and/or Sec-Fetch-Site and are checked above.
  if (!origin.value && !referer.value) {
    return undefined;
  }

  const host = readSingleHeader(headers.host);
  if (!host.valid || !host.value) {
    return "A valid Host header is required";
  }

  const expectedOrigin = parseRequestHostOrigin(host.value);
  if (!expectedOrigin) {
    return "The Host header is invalid";
  }

  if (
    origin.value &&
    parseProvenanceOrigin(origin.value, true) !== expectedOrigin
  ) {
    return "The Origin header does not match this Playground server";
  }

  if (
    referer.value &&
    parseProvenanceOrigin(referer.value, false) !== expectedOrigin
  ) {
    return "The Referer header does not match this Playground server";
  }

  return undefined;
}

export async function listenForPlayground(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readSingleHeader(value: string | string[] | undefined): {
  valid: boolean;
  value?: string;
} {
  if (value === undefined) {
    return { valid: true };
  }
  if (Array.isArray(value)) {
    return { valid: false };
  }

  const normalized = value.trim();
  return normalized.length > 0
    ? { valid: true, value: normalized }
    : { valid: false };
}

function parseRequestHostOrigin(host: string): string | undefined {
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function parseProvenanceOrigin(
  value: string,
  requireOriginOnly: boolean,
): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (
      requireOriginOnly &&
      (parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash)
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}
