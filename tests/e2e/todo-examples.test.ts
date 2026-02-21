import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import test from "node:test";
import { type Browser, chromium, type Page } from "playwright";

const REPO_ROOT = process.cwd();
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

test("e2e: runtime-plan todo example renders and remains interactive", async (t) => {
  const staticServer = await startStaticRepoServer();
  let browser: Browser | undefined;

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      t.skip(
        `playwright chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const page = await browser.newPage();
    await page.goto(
      `${staticServer.origin}/examples/todo/react-shadcn-todo.html`,
      {
        waitUntil: "networkidle",
      },
    );

    await waitForRenderedStatus(page, "todo_runtimeplan_demo");

    const report = (await page.evaluate(() => {
      const value = (window as unknown as { __RENDERIFY_TODO_DEMO__?: unknown })
        .__RENDERIFY_TODO_DEMO__;
      return value as
        | {
            planId?: string;
            diagnostics?: unknown[];
          }
        | undefined;
    })) as {
      planId?: string;
      diagnostics?: unknown[];
    };
    assert.equal(report.planId, "todo_runtimeplan_demo");
    assert.ok(Array.isArray(report.diagnostics));

    const baselineCount = await page.locator(".todo-item").count();
    await page.fill("input.input", "runtime e2e task");
    await page.click("button:has-text('Add')");

    const afterAddCount = await page.locator(".todo-item").count();
    assert.equal(afterAddCount, baselineCount + 1);

    const firstTextAfterAdd = await page
      .locator(".todo-item .todo-text")
      .first()
      .textContent();
    assert.match(firstTextAfterAdd ?? "", /runtime e2e task/);

    await page.locator(".todo-item .todo-check").first().check();
    const firstClassAfterToggle = await page
      .locator(".todo-item .todo-text")
      .first()
      .getAttribute("class");
    assert.match(firstClassAfterToggle ?? "", /\bdone\b/);

    await page
      .locator(".todo-item button[aria-label='Delete']")
      .first()
      .click();
    const afterDeleteCount = await page.locator(".todo-item").count();
    assert.equal(afterDeleteCount, baselineCount);
  } finally {
    await browser?.close();
    await staticServer.close();
  }
});

test("e2e: runtime-plan hash todo example rehydrates from shared hash", async (t) => {
  const staticServer = await startStaticRepoServer();
  let browser: Browser | undefined;

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      t.skip(
        `playwright chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const page = await browser.newPage();
    await page.goto(
      `${staticServer.origin}/examples/todo/react-shadcn-todo-hash.html`,
      {
        waitUntil: "networkidle",
      },
    );

    await waitForRenderedStatus(page, "todo_runtimeplan_hash_demo");

    const report = (await page.evaluate(() => {
      const value = (
        window as unknown as { __RENDERIFY_TODO_HASH_DEMO__?: unknown }
      ).__RENDERIFY_TODO_HASH_DEMO__;
      return value as
        | {
            planId?: string;
          }
        | undefined;
    })) as {
      planId?: string;
    };
    assert.equal(report.planId, "todo_runtimeplan_hash_demo");

    await page.fill("input.input", "hash synced task");
    await page.click("button:has-text('Add')");

    await page.waitForFunction(() => {
      const rawHash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const payload = new URLSearchParams(rawHash).get("state64");
      if (!payload) return false;

      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded =
        normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const json = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(json) as {
        todos?: Array<{
          text?: string;
        }>;
      };
      return Boolean(
        parsed.todos?.some((item) => item?.text === "hash synced task"),
      );
    });
    const sharedHash = await page.evaluate(() => window.location.hash);
    assert.match(sharedHash, /state64=/);

    const mirroredPage = await browser.newPage();
    await mirroredPage.goto(
      `${staticServer.origin}/examples/todo/react-shadcn-todo-hash.html${sharedHash}`,
      {
        waitUntil: "networkidle",
      },
    );

    await waitForRenderedStatus(mirroredPage, "todo_runtimeplan_hash_demo");
    const listText = await mirroredPage.locator(".todo-list").textContent();
    assert.match(listText ?? "", /hash synced task/);

    await mirroredPage.close();
  } finally {
    await browser?.close();
    await staticServer.close();
  }
});

async function waitForRenderedStatus(
  page: Page,
  planId: string,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedPlanId }) => {
      const status =
        document.getElementById("runtime-status")?.textContent ?? "";
      return (
        status.includes(`RuntimePlan rendered: ${expectedPlanId}`) ||
        status.includes("RuntimePlan failed:")
      );
    },
    { expectedPlanId: planId },
    { timeout: 20000 },
  );

  const status = await page.textContent("#runtime-status");
  assert.match(
    status ?? "",
    new RegExp(`RuntimePlan rendered: ${escapeRegExp(planId)}`),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function startStaticRepoServer(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      void handleStaticRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendText(res, 500, `internal error: ${message}`);
      });
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("static server did not return a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const relativePath = requestUrl.pathname.replace(/^\/+/, "");
  const safeRelativePath =
    relativePath.length > 0 ? relativePath : "index.html";
  const filePath = path.resolve(REPO_ROOT, safeRelativePath);

  if (!isInsideRepo(filePath)) {
    sendText(res, 403, "forbidden");
    return;
  }

  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    fileStats = await stat(filePath);
  } catch {
    sendText(res, 404, "not found");
    return;
  }

  if (!fileStats.isFile()) {
    sendText(res, 404, "not found");
    return;
  }

  const body = await readFile(filePath);
  const contentType =
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", body.length);
  res.end(body);
}

function isInsideRepo(candidate: string): boolean {
  const root = path.resolve(REPO_ROOT);
  const normalized = path.resolve(candidate);
  return normalized === root || normalized.startsWith(`${root}${path.sep}`);
}

async function closeServer(server: Server): Promise<void> {
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

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  const bytes = Buffer.from(body, "utf8");
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("content-length", bytes.length);
  res.end(bytes);
}
