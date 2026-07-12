/**
 * CSP feasibility harness for the MCP Apps shell.
 *
 * This is the week-1 risk falsification: can Renderify actually execute inside
 * the MCP Apps sandboxed iframe under a restrictive Content-Security-Policy?
 *
 * It loads the real shell in a sandboxed iframe driven by a mock host that
 * speaks the MCP JSON-RPC postMessage protocol, and measures — in real Chromium
 * with CSP enforced — what renders, what egresses the network, and what CSP
 * refuses. Findings are written up in docs/mcp-apps.md.
 *
 * Result summary (asserted below):
 *   - Tier A (self-contained, declarative RuntimeNode plan) renders fully
 *     offline under a STRICT hash-based CSP (`default-src 'none'`, no
 *     `'unsafe-inline'`, `connect-src 'none'`): zero external requests, zero CSP
 *     violations, and the JSON-RPC bridge round-trips (host receives
 *     `ui/update-model-context`).
 *   - `script-src blob:` is a hard requirement of any tier that executes
 *     transpiled module source: blob-URL dynamic import is REFUSED without it
 *     and permitted with it. (Declarative plans do not need it.)
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { bundleBrowserRuntime, createRenderifyShell } from "@renderify/mcp-app";
import { type Browser, chromium } from "playwright";

const HOST_RENDER_TIMEOUT_MS = 8000;

async function launchChromium(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    console.warn(
      `playwright chromium is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

interface ServeHandle {
  base: string;
  close: () => Promise<void>;
}

async function serve(
  routes: Record<string, { type: string; body: string }>,
  fallback: { type: string; body: string },
): Promise<ServeHandle> {
  const server: Server = createServer((req, res) => {
    const route = req.url ? routes[req.url] : undefined;
    const picked = route ?? fallback;
    res.setHeader("content-type", picked.type);
    res.end(picked.body);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function mockHostPage(toolResult: unknown): string {
  // The host owns the parent frame; it posts the Renderify payload as a
  // tool-result notification and records everything the iframe sends back.
  return `<!doctype html><html><body>
<iframe id="f" src="/shell" sandbox="allow-scripts" style="width:640px;height:320px;border:0"></iframe>
<script>
  window.__fromIframe = [];
  window.addEventListener("message", function (e) { window.__fromIframe.push(e.data); });
  var f = document.getElementById("f");
  f.addEventListener("load", function () {
    setTimeout(function () {
      f.contentWindow.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: ${JSON.stringify(
          { result: { structuredContent: { renderify: toolResult } } },
        )} },
        "*"
      );
    }, 30);
  });
</script>
</body></html>`;
}

let cachedRuntime: string | undefined;
async function runtimeBundle(): Promise<string> {
  if (!cachedRuntime) {
    cachedRuntime = (
      await bundleBrowserRuntime({
        runtimeEntry: "@renderify/runtime",
        resolveDir: process.cwd(),
      })
    ).code;
  }
  return cachedRuntime;
}

test("mcp-csp: Tier A declarative plan renders offline under strict hash CSP", async () => {
  const browser = await launchChromium();
  if (!browser) {
    return;
  }

  const shell = await createRenderifyShell({
    mode: "self-contained",
    runtimeBundle: await runtimeBundle(),
    securityProfile: "balanced",
    autoPinModules: false,
    useScriptHashes: true,
  });

  // Strict policy invariants we are about to enforce in a real browser.
  assert.match(shell.csp, /default-src 'none'/);
  assert.match(shell.csp, /script-src[^;]*sha256-/);
  assert.doesNotMatch(shell.csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(shell.csp, /connect-src 'none'/);

  const plan = {
    specVersion: "runtime-plan/v1",
    id: "csp-declarative",
    version: 1,
    root: {
      type: "element",
      tag: "section",
      children: [{ type: "text", value: "Hello MCP Apps" }],
    },
  };

  const handle = await serve(
    { "/shell": { type: "text/html", body: shell.html } },
    { type: "text/html", body: mockHostPage({ plan }) },
  );

  try {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    const cspViolations: string[] = [];
    page.on("request", (req) => {
      try {
        if (new URL(req.url()).hostname !== "127.0.0.1") {
          externalRequests.push(req.url());
        }
      } catch {
        /* ignore */
      }
    });
    page.on("console", (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to/i.test(text)) {
        cspViolations.push(text);
      }
    });

    await page.goto(handle.base, { waitUntil: "networkidle" });

    // The iframe is sandboxed without allow-same-origin, so the parent cannot
    // read its document. Reach into the frame directly (as a host renderer's
    // own tooling would not, but Playwright can) to assert what rendered.
    const iframeHandle = await page.waitForSelector("#f");
    const frame = await iframeHandle.contentFrame();
    assert.ok(frame, "shell iframe frame not found");

    const renderedHandle = await frame.waitForFunction(
      () => {
        const root = document.getElementById("renderify-root");
        return root?.textContent?.includes("Hello") ? root.textContent : null;
      },
      undefined,
      { timeout: HOST_RENDER_TIMEOUT_MS },
    );

    const rendered = (await renderedHandle.jsonValue()) as string;
    assert.match(rendered, /Hello MCP Apps/);

    // No network egress whatsoever — the self-contained declarative tier is
    // fully offline.
    assert.deepEqual(
      externalRequests,
      [],
      `unexpected external requests: ${externalRequests.join(", ")}`,
    );
    assert.deepEqual(
      cspViolations,
      [],
      `unexpected CSP violations: ${cspViolations.join(" | ")}`,
    );

    // The JSON-RPC bridge round-tripped to the host.
    const hostMethods = (await page.evaluate(
      () =>
        (
          (window as unknown as { __fromIframe?: Array<{ method?: string }> })
            .__fromIframe ?? []
        )
          .map((m) => m.method)
          .filter(Boolean) as string[],
    )) as string[];
    assert.ok(
      hostMethods.includes("ui/update-model-context"),
      `host did not receive ui/update-model-context (got: ${hostMethods.join(", ")})`,
    );

    await page.close();
  } finally {
    await handle.close();
    await browser.close();
  }
});

test("mcp-csp: script-src blob: is load-bearing for module execution", async () => {
  const launched = await launchChromium();
  if (!launched) {
    return;
  }
  const browser = launched;

  // A minimal document that does exactly what the runtime does on the source
  // path: materialize a transpiled module as a Blob URL and dynamically import
  // it. We toggle blob: in the CSP and confirm the browser's enforcement.
  function probeDoc(allowBlob: boolean): string {
    const scriptSrc = `'self' 'unsafe-inline'${allowBlob ? " blob:" : ""}`;
    return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}" />
</head><body><script>
(async function () {
  var url = URL.createObjectURL(new Blob(["export default 42;"], { type: "text/javascript" }));
  try {
    var ns = await import(url);
    parent.postMessage({ ok: true, value: ns.default }, "*");
  } catch (e) {
    parent.postMessage({ ok: false, error: String(e && e.message || e) }, "*");
  }
})();
</script></body></html>`;
  }

  async function probe(allowBlob: boolean): Promise<{ ok: boolean }> {
    const handle = await serve(
      {},
      {
        type: "text/html",
        body: `<!doctype html><html><body>
<iframe id="f" sandbox="allow-scripts" srcdoc="${probeDoc(allowBlob)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")}"></iframe>
<script>window.__r=null;window.addEventListener("message",function(e){window.__r=e.data;});</script>
</body></html>`,
      },
    );
    try {
      const page = await browser.newPage();
      await page.goto(handle.base, { waitUntil: "domcontentloaded" });
      const result = await page.waitForFunction(
        () => (window as unknown as { __r?: { ok: boolean } }).__r ?? null,
        undefined,
        { timeout: HOST_RENDER_TIMEOUT_MS },
      );
      const value = (await result.jsonValue()) as { ok: boolean };
      await page.close();
      return value;
    } finally {
      await handle.close();
    }
  }

  const withBlob = await probe(true);
  assert.equal(withBlob.ok, true, "blob: import should succeed when allowed");

  const withoutBlob = await probe(false);
  assert.equal(
    withoutBlob.ok,
    false,
    "blob: import must be refused when script-src omits blob:",
  );

  await browser.close();
});
