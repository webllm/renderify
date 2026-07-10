import type { Server } from "node:http";

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
