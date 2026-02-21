import {
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimeExecutionProfile,
} from "@renderify/ir";
import { DEFAULT_ESM_CDN_BASE } from "./module-fetch";
import { isBrowserRuntime } from "./runtime-environment";

export const FALLBACK_MAX_IMPORTS = 50;
export const FALLBACK_MAX_COMPONENT_INVOCATIONS = 200;
export const FALLBACK_MAX_EXECUTION_MS = 1500;
export const FALLBACK_EXECUTION_PROFILE: RuntimeExecutionProfile = "standard";
export const FALLBACK_JSPM_CDN_BASE = "https://ga.jspm.io/npm";
export const FALLBACK_ESM_CDN_BASE = DEFAULT_ESM_CDN_BASE;
export const FALLBACK_ENABLE_DEPENDENCY_PREFLIGHT = true;
export const FALLBACK_FAIL_ON_DEPENDENCY_PREFLIGHT_ERROR = false;
export const FALLBACK_REMOTE_FETCH_TIMEOUT_MS = 12_000;
export const FALLBACK_REMOTE_FETCH_RETRIES = 2;
export const FALLBACK_REMOTE_FETCH_BACKOFF_MS = 150;
export const FALLBACK_REMOTE_FALLBACK_CDN_BASES = [FALLBACK_ESM_CDN_BASE];
export const FALLBACK_BROWSER_MODULE_URL_CACHE_MAX_ENTRIES = 1024;
export const FALLBACK_RUNTIME_SOURCE_LOCAL_SPECIFIER_CACHE_MAX_ENTRIES = 512;
export const FALLBACK_SUPPORTED_SPEC_VERSIONS = [
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
];
export const FALLBACK_ENFORCE_MODULE_MANIFEST = true;
export const FALLBACK_ALLOW_ISOLATION_FALLBACK = false;
export const FALLBACK_BROWSER_SOURCE_SANDBOX_TIMEOUT_MS = 4000;
export const FALLBACK_BROWSER_SOURCE_SANDBOX_FAIL_CLOSED = true;
export const FALLBACK_RUNTIME_SOURCE_JSX_HELPER_MODE = "auto";

export function normalizeSupportedSpecVersions(
  versions?: string[],
): Set<string> {
  const normalized = new Set<string>();
  const input =
    versions && versions.length > 0
      ? versions
      : FALLBACK_SUPPORTED_SPEC_VERSIONS;

  for (const entry of input) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  if (normalized.size === 0) {
    normalized.add(DEFAULT_RUNTIME_PLAN_SPEC_VERSION);
  }

  return normalized;
}

export function normalizeSourceSandboxMode(
  mode: "none" | "worker" | "iframe" | "shadowrealm" | undefined,
): "none" | "worker" | "iframe" | "shadowrealm" {
  if (
    mode === "none" ||
    mode === "worker" ||
    mode === "iframe" ||
    mode === "shadowrealm"
  ) {
    return mode;
  }

  return isBrowserRuntime() ? "worker" : "none";
}

export function normalizeRuntimeSourceJsxHelperMode(
  mode: "auto" | "always" | "never" | undefined,
): "auto" | "always" | "never" {
  if (mode === "auto" || mode === "always" || mode === "never") {
    return mode;
  }

  return FALLBACK_RUNTIME_SOURCE_JSX_HELPER_MODE;
}

export function normalizeFallbackCdnBases(input?: string[]): string[] {
  const explicitInput = input !== undefined;
  const candidates = explicitInput ? input : FALLBACK_REMOTE_FALLBACK_CDN_BASES;
  const normalized = new Set<string>();

  for (const entry of candidates) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim().replace(/\/$/, "");
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  if (normalized.size === 0) {
    return explicitInput ? [] : [FALLBACK_ESM_CDN_BASE];
  }

  return [...normalized];
}

export function normalizePositiveInteger(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return fallback;
  }

  return value;
}

export function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return fallback;
  }

  return value;
}
