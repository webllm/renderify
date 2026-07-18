import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Credential source label for tokens imported from the official Codex CLI. */
export const CODEX_CLI_AUTH_SOURCE = "codex-cli";
const DEFAULT_CODEX_CLI_DIRNAME = ".codex";

const AUTH_STORE_VERSION = 1;
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;
const CODEX_DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export interface CodexAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  [key: string]: unknown;
}

export interface CodexAuthState {
  auth_mode: "chatgpt";
  source: string;
  base_url: string;
  last_refresh: string;
  tokens: CodexAuthTokens;
}

export interface CodexRuntimeCredentials {
  provider: typeof OPENAI_CODEX_PROVIDER;
  apiKey: string;
  baseUrl: string;
  accountId?: string;
  authFile?: string;
  source: string;
  lastRefresh?: string;
}

export interface CodexAuthStatus {
  loggedIn: boolean;
  authFile: string;
  baseUrl?: string;
  accountId?: string;
  expiresAt?: string;
  lastRefresh?: string;
  source?: string;
  error?: string;
}

export interface CodexLoginOptions {
  authFile?: string;
  fetchImpl?: typeof fetch;
  stdout?: NodeJS.WritableStream;
  now?: () => number;
  /** Maximum duration for the complete device-code login flow. */
  timeoutMs?: number;
  /** Override the server-provided polling interval (primarily for tests). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface CodexAuthStoreOptions {
  authFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CodexAuthStore {
  version: number;
  providers: Record<string, CodexAuthState | undefined>;
}

/**
 * Shape of the official OpenAI Codex CLI `auth.json` file. Only the ChatGPT
 * OAuth token sub-object is consumed; unknown keys are preserved on write-back.
 */
interface CodexCliAuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  [key: string]: unknown;
}

interface CodexCliAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexCliAuthTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

/** Whether and how to consult the local Codex CLI credentials. */
export type CodexCliAuthUsage = boolean | "only";

export interface CodexCliAuthOptions {
  /**
   * Enable importing credentials from the official Codex CLI `auth.json`.
   * `true` prefers the Codex CLI file and falls back to Renderify's own store;
   * `"only"` uses the Codex CLI file exclusively; `false` disables it. When
   * omitted, the `RENDERIFY_CODEX_USE_CLI_AUTH` environment variable is used.
   */
  useCliAuth?: CodexCliAuthUsage;
  /** Override the Codex CLI auth file path (primarily for tests). */
  cliAuthFile?: string;
}

interface EffectiveCodexAuthState {
  state: CodexAuthState;
  authFile: string;
  origin: "renderify" | "codex-cli";
}

interface DeviceAuthUserCodePayload {
  user_code?: string;
  device_auth_id?: string;
  interval?: number | string;
}

interface DeviceAuthTokenPayload {
  authorization_code?: string;
  code_verifier?: string;
}

interface OAuthTokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

export function resolveRenderifyHome(): string {
  const configured = process.env.RENDERIFY_HOME?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }

  return path.join(os.homedir(), ".renderify");
}

export function resolveCodexAuthFile(): string {
  const configured = process.env.RENDERIFY_CODEX_AUTH_FILE?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }

  return path.join(resolveRenderifyHome(), "auth.json");
}

/** Home directory the official Codex CLI stores credentials in (`$CODEX_HOME`). */
export function resolveCodexCliHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }

  return path.join(os.homedir(), DEFAULT_CODEX_CLI_DIRNAME);
}

/** Path to the official Codex CLI `auth.json` (honours `$CODEX_HOME`). */
export function resolveCodexCliAuthFile(): string {
  const configured = process.env.RENDERIFY_CODEX_CLI_AUTH_FILE?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }

  return path.join(resolveCodexCliHome(), "auth.json");
}

export async function loginCodex(
  options: CodexLoginOptions = {},
): Promise<CodexAuthState> {
  const timeoutMs = normalizeLoginTimeout(options.timeoutMs);
  const deadline = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    deadline.abort(new Error("Codex login timed out."));
  }, timeoutMs);

  const abortFromCaller = () => {
    deadline.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await loginCodexWithSignal(options, deadline.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Codex login timed out after ${formatDuration(timeoutMs)}.`,
      );
    }

    if (deadline.signal.aborted) {
      throw abortReason(deadline.signal.reason);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function loginCodexWithSignal(
  options: CodexLoginOptions,
  signal: AbortSignal,
): Promise<CodexAuthState> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  const stdout = options.stdout ?? process.stdout;
  const userCodeResponse = await runAbortable(
    () =>
      fetchImpl(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: CODEX_OAUTH_CLIENT_ID,
        }),
        signal,
      }),
    signal,
  );

  if (!userCodeResponse.ok) {
    throw new Error(
      `Codex device code request failed (${userCodeResponse.status}): ${await runAbortable(
        () => readResponseDetails(userCodeResponse),
        signal,
      )}`,
    );
  }

  const deviceData = (await runAbortable(
    () => userCodeResponse.json(),
    signal,
  )) as DeviceAuthUserCodePayload;
  const userCode = stringOrUndefined(deviceData.user_code);
  const deviceAuthId = stringOrUndefined(deviceData.device_auth_id);
  const pollIntervalMs =
    options.pollIntervalMs === undefined
      ? Math.max(3000, Number(deviceData.interval ?? 5) * 1000)
      : Math.max(0, Math.floor(options.pollIntervalMs));

  if (!userCode || !deviceAuthId) {
    throw new Error("Codex device code response missing required fields.");
  }

  stdout.write("To continue, follow these steps:\n\n");
  stdout.write("  1. Open this URL in your browser:\n");
  stdout.write(`     ${CODEX_AUTH_ISSUER}/codex/device\n\n`);
  stdout.write("  2. Enter this code:\n");
  stdout.write(`     ${userCode}\n\n`);
  stdout.write("Waiting for sign-in... (press Ctrl+C to cancel)\n");

  let authorization: DeviceAuthTokenPayload | undefined;
  while (!signal.aborted) {
    await delay(pollIntervalMs, undefined, { signal });
    const pollResponse = await runAbortable(
      () =>
        fetchImpl(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_auth_id: deviceAuthId,
            user_code: userCode,
          }),
          signal,
        }),
      signal,
    );

    if (pollResponse.status === 403 || pollResponse.status === 404) {
      continue;
    }

    if (!pollResponse.ok) {
      throw new Error(
        `Codex device auth polling failed (${pollResponse.status}): ${await runAbortable(
          () => readResponseDetails(pollResponse),
          signal,
        )}`,
      );
    }

    authorization = (await runAbortable(
      () => pollResponse.json(),
      signal,
    )) as DeviceAuthTokenPayload;
    break;
  }

  if (!authorization) {
    throw abortReason(signal.reason);
  }

  const authorizationCode = stringOrUndefined(authorization.authorization_code);
  const codeVerifier = stringOrUndefined(authorization.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new Error(
      "Codex device auth response missing authorization_code or code_verifier.",
    );
  }

  const tokenResponse = await runAbortable(
    () =>
      fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: `${CODEX_AUTH_ISSUER}/deviceauth/callback`,
          client_id: CODEX_OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
        }),
        signal,
      }),
    signal,
  );

  if (!tokenResponse.ok) {
    throw new Error(
      `Codex token exchange failed (${tokenResponse.status}): ${await runAbortable(
        () => readResponseDetails(tokenResponse),
        signal,
      )}`,
    );
  }

  const tokenPayload = (await runAbortable(
    () => tokenResponse.json(),
    signal,
  )) as OAuthTokenPayload;
  const tokens = normalizeOAuthTokenPayload(tokenPayload, options.now);
  const state = createCodexAuthState(tokens, {
    source: "device-code",
    now: options.now,
  });
  await runAbortable(() => saveCodexAuthState(state, options), signal);
  return state;
}

async function runAbortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal.reason);
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal.reason));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}

function abortReason(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error("Codex login cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeLoginTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return CODEX_DEVICE_AUTH_TIMEOUT_MS;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex login timeout must be a positive finite number.");
  }

  return Math.max(1, Math.floor(timeoutMs));
}

function formatDuration(durationMs: number): string {
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  return `${durationMs} ms`;
}

export async function getCodexAuthStatus(
  options: CodexAuthStoreOptions & CodexCliAuthOptions = {},
): Promise<CodexAuthStatus> {
  const effective = await loadEffectiveCodexAuthState(options);
  if (!effective) {
    return {
      loggedIn: false,
      authFile: options.authFile ?? resolveCodexAuthFile(),
      error: "No OpenAI Codex credentials stored.",
    };
  }

  const { state, authFile } = effective;
  const accessToken = state.tokens.access_token;
  const expiresAt = resolveTokenExpiresAt(accessToken, state.tokens);
  const expired = isAccessTokenExpiring(
    accessToken,
    state.tokens,
    0,
    options.now,
  );
  return {
    loggedIn: !expired,
    authFile,
    baseUrl: state.base_url,
    accountId: resolveChatGptAccountId(accessToken),
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined,
    lastRefresh: state.last_refresh,
    source: state.source,
    ...(expired
      ? { error: "Stored OpenAI Codex access token is expired." }
      : {}),
  };
}

export async function logoutCodex(
  options: CodexAuthStoreOptions = {},
): Promise<boolean> {
  const authFile = options.authFile ?? resolveCodexAuthFile();
  const authFileExists = await fileExists(authFile);
  const store = await readAuthStore(authFile);
  const hadState = Boolean(store.providers[OPENAI_CODEX_PROVIDER]);
  if (!hadState && !authFileExists) {
    return false;
  }

  delete store.providers[OPENAI_CODEX_PROVIDER];
  await writeAuthStore(authFile, store);
  return hadState;
}

export async function resolveCodexRuntimeCredentials(
  options: CodexAuthStoreOptions &
    CodexCliAuthOptions & {
      explicitAccessToken?: string;
      explicitBaseUrl?: string;
    } = {},
): Promise<CodexRuntimeCredentials> {
  const explicitAccessToken =
    process.env.RENDERIFY_CODEX_ACCESS_TOKEN?.trim() ||
    options.explicitAccessToken?.trim();
  const explicitBaseUrl =
    process.env.RENDERIFY_CODEX_BASE_URL?.trim().replace(/\/$/, "") ||
    options.explicitBaseUrl?.trim().replace(/\/$/, "");

  if (explicitAccessToken) {
    return {
      provider: OPENAI_CODEX_PROVIDER,
      apiKey: explicitAccessToken,
      baseUrl: explicitBaseUrl || DEFAULT_CODEX_BASE_URL,
      accountId: resolveChatGptAccountId(explicitAccessToken),
      source: "explicit",
    };
  }

  const effective = await loadEffectiveCodexAuthState(options);
  if (!effective) {
    throw new Error(
      "OpenAI Codex credentials are missing. Run `renderify auth codex login`, " +
        "log in with the Codex CLI and set RENDERIFY_CODEX_USE_CLI_AUTH=1, or " +
        "set RENDERIFY_CODEX_ACCESS_TOKEN.",
    );
  }

  const { state, authFile, origin } = effective;
  let tokens = state.tokens;
  if (
    isAccessTokenExpiring(
      tokens.access_token,
      tokens,
      CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
      options.now,
    )
  ) {
    tokens = await refreshCodexTokens(tokens, options);
    const lastRefresh = new Date(options.now?.() ?? Date.now()).toISOString();
    if (origin === "codex-cli") {
      // Persist the rotated tokens back to the Codex CLI file in its native
      // format so the user's Codex CLI keeps working. Best effort: a failed
      // write must not block runtime usage of the freshly refreshed token.
      try {
        await writeCodexCliAuthState(authFile, tokens, { now: options.now });
      } catch {
        // Ignore write-back failures and continue with the in-memory token.
      }
    } else {
      await saveCodexAuthState(
        {
          ...state,
          tokens,
          last_refresh: lastRefresh,
        },
        {
          ...options,
          authFile,
        },
      );
    }
    state.last_refresh = lastRefresh;
  }

  return {
    provider: OPENAI_CODEX_PROVIDER,
    apiKey: tokens.access_token,
    baseUrl: explicitBaseUrl || state.base_url || DEFAULT_CODEX_BASE_URL,
    accountId: resolveChatGptAccountId(tokens.access_token),
    authFile,
    source: state.source,
    lastRefresh: state.last_refresh,
  };
}

/**
 * Resolves the active Codex credential state, preferring the local Codex CLI
 * file when CLI auth is enabled and otherwise using Renderify's own store.
 */
async function loadEffectiveCodexAuthState(
  options: CodexAuthStoreOptions & CodexCliAuthOptions,
): Promise<EffectiveCodexAuthState | undefined> {
  const renderifyAuthFile = options.authFile ?? resolveCodexAuthFile();
  const cli = resolveCodexCliAuthPreference(options);

  if (cli.enabled) {
    const cliState = await readCodexCliAuthState({ authFile: cli.authFile });
    if (cliState) {
      return {
        state: cliState,
        authFile: cli.authFile,
        origin: "codex-cli",
      };
    }
    if (cli.only) {
      return undefined;
    }
  }

  const state = await readCodexAuthState({
    ...options,
    authFile: renderifyAuthFile,
  });
  if (state) {
    return {
      state,
      authFile: renderifyAuthFile,
      origin: "renderify",
    };
  }

  return undefined;
}

function resolveCodexCliAuthPreference(options: CodexCliAuthOptions): {
  enabled: boolean;
  only: boolean;
  authFile: string;
} {
  const authFile = options.cliAuthFile ?? resolveCodexCliAuthFile();

  if (options.useCliAuth === false) {
    return { enabled: false, only: false, authFile };
  }
  if (options.useCliAuth === "only") {
    return { enabled: true, only: true, authFile };
  }
  if (options.useCliAuth === true) {
    return { enabled: true, only: false, authFile };
  }

  const env = process.env.RENDERIFY_CODEX_USE_CLI_AUTH?.trim().toLowerCase();
  const only = env === "only";
  const enabled =
    only ||
    env === "1" ||
    env === "true" ||
    env === "yes" ||
    env === "on" ||
    env === "prefer";
  return { enabled, only, authFile };
}

/**
 * Reads and adapts the official Codex CLI `auth.json` to a `CodexAuthState`.
 * Returns undefined when the file is absent, unreadable, or lacks a usable
 * ChatGPT OAuth token pair.
 */
export async function readCodexCliAuthState(
  options: { authFile?: string } = {},
): Promise<CodexAuthState | undefined> {
  const authFile = options.authFile ?? resolveCodexCliAuthFile();

  let raw: string;
  try {
    raw = await fs.promises.readFile(authFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const cliTokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const accessToken = stringOrUndefined(cliTokens?.access_token);
  const refreshToken = stringOrUndefined(cliTokens?.refresh_token);
  if (!accessToken || !refreshToken) {
    return undefined;
  }

  const tokens: CodexAuthTokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
  };
  const idToken = stringOrUndefined(cliTokens?.id_token);
  if (idToken) {
    tokens.id_token = idToken;
  }
  const accountId = stringOrUndefined(cliTokens?.account_id);
  if (accountId) {
    tokens.account_id = accountId;
  }

  return {
    auth_mode: "chatgpt",
    source: CODEX_CLI_AUTH_SOURCE,
    base_url: DEFAULT_CODEX_BASE_URL,
    last_refresh:
      stringOrUndefined(parsed.last_refresh) ?? new Date(0).toISOString(),
    tokens,
  };
}

/**
 * Writes refreshed tokens back to the Codex CLI `auth.json`, preserving unknown
 * top-level keys and the token sub-object's other fields. Atomic (temp+rename).
 */
async function writeCodexCliAuthState(
  authFile: string,
  tokens: CodexAuthTokens,
  options: { now?: () => number } = {},
): Promise<void> {
  let existing: CodexCliAuthFile = {};
  try {
    const raw = await fs.promises.readFile(authFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      existing = parsed as CodexCliAuthFile;
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  const existingTokens = isRecord(existing.tokens) ? existing.tokens : {};
  const nextTokens: CodexCliAuthTokens = {
    ...existingTokens,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };
  const idToken = stringOrUndefined(tokens.id_token);
  if (idToken) {
    nextTokens.id_token = idToken;
  }

  const next: CodexCliAuthFile = {
    ...existing,
    tokens: nextTokens,
    last_refresh: new Date(options.now?.() ?? Date.now()).toISOString(),
  };

  await fs.promises.mkdir(path.dirname(authFile), {
    recursive: true,
    mode: 0o700,
  });
  const tempFile = `${authFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempFile, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.promises.rename(tempFile, authFile);
  await fs.promises.chmod(authFile, 0o600);
}

export async function readCodexAuthState(
  options: CodexAuthStoreOptions = {},
): Promise<CodexAuthState | undefined> {
  const authFile = options.authFile ?? resolveCodexAuthFile();
  const store = await readAuthStore(authFile);
  return store.providers[OPENAI_CODEX_PROVIDER];
}

export async function saveCodexAuthState(
  state: CodexAuthState,
  options: CodexAuthStoreOptions = {},
): Promise<void> {
  const authFile = options.authFile ?? resolveCodexAuthFile();
  const store = await readAuthStore(authFile);
  store.providers[OPENAI_CODEX_PROVIDER] = state;
  await writeAuthStore(authFile, store);
}

export function createCodexAuthState(
  tokens: CodexAuthTokens,
  options: {
    source?: string;
    baseUrl?: string;
    now?: () => number;
  } = {},
): CodexAuthState {
  return {
    auth_mode: "chatgpt",
    source: options.source ?? "manual",
    base_url: options.baseUrl ?? DEFAULT_CODEX_BASE_URL,
    last_refresh: new Date(options.now?.() ?? Date.now()).toISOString(),
    tokens,
  };
}

export function resolveChatGptAccountId(
  accessToken: string,
): string | undefined {
  try {
    const claims = decodeJwtPayload(accessToken);
    if (!isRecord(claims)) {
      return undefined;
    }

    const authClaims = claims["https://api.openai.com/auth"];
    if (!isRecord(authClaims)) {
      return undefined;
    }

    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim().length > 0
      ? accountId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function refreshCodexTokens(
  tokens: CodexAuthTokens,
  options: CodexAuthStoreOptions,
): Promise<CodexAuthTokens> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed (${response.status}): ${await readResponseDetails(
        response,
      )}`,
    );
  }

  const payload = (await response.json()) as OAuthTokenPayload;
  const accessToken = stringOrUndefined(payload.access_token);
  if (!accessToken) {
    throw new Error("Codex token refresh response missing access_token.");
  }

  const refreshToken =
    stringOrUndefined(payload.refresh_token) ?? tokens.refresh_token;
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in)
      ? Math.max(1, Math.floor(payload.expires_in))
      : undefined;

  return {
    ...tokens,
    ...payload,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresIn
      ? {
          expires_at:
            Math.floor((options.now?.() ?? Date.now()) / 1000) + expiresIn,
        }
      : {}),
  };
}

function normalizeOAuthTokenPayload(
  payload: OAuthTokenPayload,
  now: (() => number) | undefined,
): CodexAuthTokens {
  const accessToken = stringOrUndefined(payload.access_token);
  const refreshToken = stringOrUndefined(payload.refresh_token);
  if (!accessToken) {
    throw new Error("Codex OAuth response missing access_token.");
  }

  if (!refreshToken) {
    throw new Error("Codex OAuth response missing refresh_token.");
  }

  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in)
      ? Math.max(1, Math.floor(payload.expires_in))
      : undefined;

  return {
    ...payload,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresIn
      ? { expires_at: Math.floor((now?.() ?? Date.now()) / 1000) + expiresIn }
      : {}),
  };
}

function isAccessTokenExpiring(
  accessToken: string,
  tokens: CodexAuthTokens,
  skewSeconds: number,
  now: (() => number) | undefined,
): boolean {
  const expiresAt = resolveTokenExpiresAt(accessToken, tokens);
  if (expiresAt === undefined) {
    return false;
  }

  return expiresAt <= Math.floor((now?.() ?? Date.now()) / 1000) + skewSeconds;
}

function resolveTokenExpiresAt(
  accessToken: string,
  tokens: CodexAuthTokens,
): number | undefined {
  if (
    typeof tokens.expires_at === "number" &&
    Number.isFinite(tokens.expires_at)
  ) {
    return Math.floor(tokens.expires_at);
  }

  try {
    const claims = decodeJwtPayload(accessToken);
    if (!isRecord(claims)) {
      return undefined;
    }

    const exp = claims.exp;
    return typeof exp === "number" && Number.isFinite(exp)
      ? Math.floor(exp)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readAuthStore(authFile: string): Promise<CodexAuthStore> {
  try {
    const raw = await fs.promises.readFile(authFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return emptyAuthStore();
    }

    const providers = isRecord(parsed.providers) ? parsed.providers : {};
    return {
      version:
        typeof parsed.version === "number"
          ? Math.floor(parsed.version)
          : AUTH_STORE_VERSION,
      providers: providers as Record<string, CodexAuthState | undefined>,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyAuthStore();
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeAuthStore(
  authFile: string,
  store: CodexAuthStore,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(authFile), {
    recursive: true,
    mode: 0o700,
  });

  const normalized: CodexAuthStore = {
    version: AUTH_STORE_VERSION,
    providers: store.providers,
  };
  const tempFile = `${authFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(
    tempFile,
    `${JSON.stringify(normalized, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await fs.promises.rename(tempFile, authFile);
  await fs.promises.chmod(authFile, 0o600);
}

function emptyAuthStore(): CodexAuthStore {
  return {
    version: AUTH_STORE_VERSION,
    providers: {},
  };
}

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("Global fetch is unavailable.");
}

async function readResponseDetails(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    if (isRecord(payload)) {
      const error = payload.error;
      if (isRecord(error) && typeof error.message === "string") {
        return error.message;
      }

      if (typeof error === "string") {
        return error;
      }

      if (typeof payload.message === "string") {
        return payload.message;
      }
    }

    return JSON.stringify(payload);
  } catch {
    try {
      return await response.text();
    } catch {
      return "unknown error";
    }
  }
}

function decodeJwtPayload(accessToken: string): unknown {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  const payload = parts[1];
  const normalized = `${payload.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (payload.length % 4)) % 4,
  )}`;
  return JSON.parse(
    Buffer.from(normalized, "base64").toString("utf8"),
  ) as unknown;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
