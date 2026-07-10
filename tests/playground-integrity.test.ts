import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RemoteModuleIntegrityFetcher } from "../packages/cli/src/playground-integrity";

const ALLOWED_POLICY = {
  allowArbitraryNetwork: false,
  allowedNetworkHosts: ["allowed.example"],
};

test("playground integrity fetch blocks disallowed initial hosts", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher();
  let fetchCount = 0;

  const integrity = await fetcher.fetch("https://blocked.example/module.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("export default 1;");
    },
  });

  assert.equal(integrity, undefined);
  assert.equal(fetchCount, 0);
});

test("playground integrity fetch rejects redirects before contacting a blocked host", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher();
  const requestedUrls: string[] = [];

  const integrity = await fetcher.fetch("https://allowed.example/entry.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://blocked.example/private" },
      });
    },
  });

  assert.equal(integrity, undefined);
  assert.deepEqual(requestedUrls, ["https://allowed.example/entry.js"]);
});

test("playground integrity fetch follows bounded allowed redirects", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher();
  const source = "export default 1;";
  const requestedUrls: string[] = [];

  const integrity = await fetcher.fetch("https://allowed.example/entry.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/entry.js")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/module.js" },
        });
      }
      return new Response(source, { status: 200 });
    },
  });

  assert.equal(
    integrity,
    `sha384-${createHash("sha384").update(source).digest("base64")}`,
  );
  assert.deepEqual(requestedUrls, [
    "https://allowed.example/entry.js",
    "https://allowed.example/module.js",
  ]);
});

test("playground integrity fetch stops at its redirect limit", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher({ maxRedirects: 1 });
  let fetchCount = 0;

  const integrity = await fetcher.fetch("https://allowed.example/start.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/redirect-${fetchCount}.js` },
      });
    },
  });

  assert.equal(integrity, undefined);
  assert.equal(fetchCount, 2);
});

test("playground integrity fetch rejects declared oversized bodies before reading", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher({ maxBytes: 5 });
  let cancellations = 0;
  let reads = 0;
  const response = {
    ok: true,
    status: 200,
    url: "https://allowed.example/module.js",
    headers: new Headers({ "content-length": "6" }),
    body: {
      locked: false,
      cancel: async () => {
        cancellations += 1;
      },
      getReader: () => {
        reads += 1;
        throw new Error("body should not be read");
      },
    },
  } as unknown as Response;

  const integrity = await fetcher.fetch("https://allowed.example/module.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async () => response,
  });
  await Promise.resolve();

  assert.equal(integrity, undefined);
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
});

test("playground integrity fetch bounds streamed bodies and caches only success", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher({ maxBytes: 5 });
  let fetchCount = 0;
  let cancellations = 0;

  const fetchImpl: typeof fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return createStreamingResponse(["abc", "def"], {
        contentLength: "1",
        leaveOpen: true,
        onCancel: () => {
          cancellations += 1;
        },
      });
    }
    return createStreamingResponse(["abc"]);
  };

  const first = await fetcher.fetch("https://allowed.example/module.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl,
  });
  await Promise.resolve();
  assert.equal(first, undefined);
  assert.equal(cancellations, 1);

  const second = await fetcher.fetch("https://allowed.example/module.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl,
  });
  const third = await fetcher.fetch("https://allowed.example/module.js", {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl,
  });

  const expected = `sha384-${createHash("sha384")
    .update("abc")
    .digest("base64")}`;
  assert.equal(second, expected);
  assert.equal(third, expected);
  assert.equal(fetchCount, 2);
});

test("playground integrity fetch evicts least-recently-used cache entries", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher({ cacheMaxEntries: 2 });
  let fetchCount = 0;
  const options = {
    timeoutMs: 100,
    networkPolicy: {
      allowArbitraryNetwork: true,
      allowedNetworkHosts: [],
    },
    fetchImpl: async (input: RequestInfo | URL) => {
      fetchCount += 1;
      return new Response(String(input));
    },
  };

  await fetcher.fetch("https://one.example/module.js", options);
  await fetcher.fetch("https://two.example/module.js", options);
  await fetcher.fetch("https://three.example/module.js", options);
  await fetcher.fetch("https://one.example/module.js", options);

  assert.equal(fetchCount, 4);
});

test("playground integrity fetch does not share cache entries across policies", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher();
  let fetchCount = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCount += 1;
    return new Response("export default 1;");
  };
  const url = "https://allowed.example/module.js";

  await fetcher.fetch(url, {
    timeoutMs: 100,
    networkPolicy: {
      allowArbitraryNetwork: true,
      allowedNetworkHosts: [],
    },
    fetchImpl,
  });
  await fetcher.fetch(url, {
    timeoutMs: 100,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl,
  });

  assert.equal(fetchCount, 2);
});

test("playground integrity fetch aborts an unresponsive request", async () => {
  const fetcher = new RemoteModuleIntegrityFetcher();

  const integrity = await fetcher.fetch("https://allowed.example/module.js", {
    timeoutMs: 5,
    networkPolicy: ALLOWED_POLICY,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  });

  assert.equal(integrity, undefined);
});

function createStreamingResponse(
  chunks: string[],
  options: {
    contentLength?: string;
    leaveOpen?: boolean;
    onCancel?: () => void;
  } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (!options.leaveOpen) {
        controller.close();
      }
    },
    cancel() {
      options.onCancel?.();
    },
  });
  const headers = new Headers();
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Response(body, { status: 200, headers });
}
