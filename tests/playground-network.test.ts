import assert from "node:assert/strict";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  DEFAULT_PLAYGROUND_HOST,
  formatPlaygroundUrlHost,
  getPlaygroundMutationRejectionReason,
  listenForPlayground,
  resolvePlaygroundHost,
} from "../packages/cli/src/playground-network";

test("playground defaults its listening socket to IPv4 loopback", async () => {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });

  try {
    const host = resolvePlaygroundHost(undefined, undefined);
    assert.equal(host, DEFAULT_PLAYGROUND_HOST);

    await listenForPlayground(server, 0, host);

    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal((address as AddressInfo).address, "127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("playground host configuration overrides the loopback default", () => {
  assert.equal(resolvePlaygroundHost(undefined, "0.0.0.0"), "0.0.0.0");
  assert.equal(resolvePlaygroundHost("localhost", "0.0.0.0"), "localhost");
  assert.equal(formatPlaygroundUrlHost("::1"), "[::1]");
});

test("playground accepts same-origin browser mutations", () => {
  assert.equal(
    getPlaygroundMutationRejectionReason({
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      referer: "http://127.0.0.1:4317/playground?mode=plan",
      "sec-fetch-site": "same-origin",
    }),
    undefined,
  );
});

test("playground keeps non-browser mutation clients usable", () => {
  assert.equal(
    getPlaygroundMutationRejectionReason({ host: "127.0.0.1:4317" }),
    undefined,
  );
});

test("playground rejects cross-origin browser mutations", () => {
  const rejectedHeaders = [
    {
      host: "127.0.0.1:4317",
      origin: "https://attacker.example",
    },
    {
      host: "127.0.0.1:4317",
      referer: "https://attacker.example/form",
    },
    {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4318",
    },
    {
      host: "127.0.0.1:4317",
      origin: "https://127.0.0.1:4317",
    },
    {
      host: "127.0.0.1:4317",
      origin: "null",
    },
    {
      host: "127.0.0.1:4317",
      "sec-fetch-site": "cross-site",
    },
  ];

  for (const headers of rejectedHeaders) {
    assert.equal(
      typeof getPlaygroundMutationRejectionReason(headers),
      "string",
    );
  }
});

test("playground rejects malformed mutation provenance", () => {
  const rejectedHeaders = [
    { host: "not a valid host", origin: "http://127.0.0.1:4317" },
    { host: "127.0.0.1:4317", origin: "" },
    { host: "127.0.0.1:4317", origin: ["http://127.0.0.1:4317"] },
    { host: "127.0.0.1:4317", referer: ["http://127.0.0.1:4317/"] },
    { host: "127.0.0.1:4317", "sec-fetch-site": ["same-origin"] },
  ];

  for (const headers of rejectedHeaders) {
    assert.equal(
      typeof getPlaygroundMutationRejectionReason(
        headers as unknown as IncomingHttpHeaders,
      ),
      "string",
    );
  }
});
