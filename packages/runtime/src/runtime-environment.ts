export function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

export function isBrowserRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof navigator !== "undefined"
  );
}

export interface NodeVmScript {
  runInNewContext(
    contextObject: Record<string, unknown>,
    options: { timeout?: number },
  ): unknown;
}

export interface NodeVmModule {
  Script: new (code: string) => NodeVmScript;
}

export interface PreactLikeModule {
  h(type: unknown, props: unknown, ...children: unknown[]): unknown;
}

export function hasVmScript(value: unknown): value is NodeVmModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { Script?: unknown };
  return typeof candidate.Script === "function";
}

export function hasPreactFactory(value: unknown): value is PreactLikeModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { h?: unknown };
  return typeof candidate.h === "function";
}

export function getVmSpecifier(): string {
  return "node:vm";
}

export function getPreactSpecifier(): string {
  return "preact";
}
