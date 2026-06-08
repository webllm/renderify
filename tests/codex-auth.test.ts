import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createCodexAuthState,
  getCodexAuthStatus,
  resolveCodexRuntimeCredentials,
  saveCodexAuthState,
} from "../packages/cli/src/codex-auth";

test("codex auth status reports missing credentials without creating a file", async (t) => {
  const authFile = await tempAuthFile(t);

  const status = await getCodexAuthStatus({
    authFile,
  });

  assert.equal(status.loggedIn, false);
  assert.equal(status.authFile, authFile);
  assert.match(String(status.error), /No OpenAI Codex credentials/);
  assert.equal(fs.existsSync(authFile), false);
});

test("codex runtime credentials resolve stored access token and account id", async (t) => {
  const authFile = await tempAuthFile(t);
  const nowMs = Date.parse("2026-06-08T10:00:00.000Z");
  const accessToken = codexAccessToken({
    accountId: "acct_renderify_auth",
    exp: Math.floor(nowMs / 1000) + 3600,
  });

  await saveCodexAuthState(
    createCodexAuthState(
      {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
      {
        source: "test",
        now: () => nowMs,
      },
    ),
    {
      authFile,
    },
  );

  const credentials = await resolveCodexRuntimeCredentials({
    authFile,
    now: () => nowMs,
  });

  assert.equal(credentials.provider, "openai-codex");
  assert.equal(credentials.apiKey, accessToken);
  assert.equal(credentials.accountId, "acct_renderify_auth");
  assert.equal(credentials.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(credentials.source, "test");

  if (process.platform !== "win32") {
    const mode = fs.statSync(authFile).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("codex runtime credentials refresh expiring access token", async (t) => {
  const authFile = await tempAuthFile(t);
  const nowMs = Date.parse("2026-06-08T10:00:00.000Z");
  const staleToken = codexAccessToken({
    accountId: "acct_old",
    exp: Math.floor(nowMs / 1000) - 30,
  });
  const freshToken = codexAccessToken({
    accountId: "acct_new",
    exp: Math.floor(nowMs / 1000) + 3600,
  });
  const requests: Array<{ url: string; body: string }> = [];

  await saveCodexAuthState(
    createCodexAuthState(
      {
        access_token: staleToken,
        refresh_token: "refresh-token",
      },
      {
        source: "test",
        now: () => nowMs - 10_000,
      },
    ),
    {
      authFile,
    },
  );

  const credentials = await resolveCodexRuntimeCredentials({
    authFile,
    now: () => nowMs,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: String(init?.body),
      });

      return new Response(
        JSON.stringify({
          access_token: freshToken,
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  assert.equal(credentials.apiKey, freshToken);
  assert.equal(credentials.accountId, "acct_new");
  assert.equal(credentials.lastRefresh, new Date(nowMs).toISOString());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://auth.openai.com/oauth/token");
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.match(requests[0].body, /refresh_token=refresh-token/);

  const status = await getCodexAuthStatus({
    authFile,
    now: () => nowMs,
  });
  assert.equal(status.loggedIn, true);
  assert.equal(status.accountId, "acct_new");
  assert.equal(status.lastRefresh, new Date(nowMs).toISOString());
});

async function tempAuthFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "renderify-codex-auth-"));
  t.after(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
    });
  });
  return path.join(dir, "auth.json");
}

function codexAccessToken(input: { accountId: string; exp: number }): string {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const payload = base64UrlEncode({
    exp: input.exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: input.accountId,
    },
  });
  return `${header}.${payload}.signature`;
}

function base64UrlEncode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
