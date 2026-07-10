import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  DEFAULT_PLAYGROUND_HOST,
  formatPlaygroundUrlHost,
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
