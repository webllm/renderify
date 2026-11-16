import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { RuntimeEvent, RuntimePlan } from "../../packages/ir/src/index";

const REPO_ROOT = process.cwd();

const HARNESS_SOURCE = `
import { createInteractiveSession, DefaultUIRenderer } from "@renderify/runtime";

const ui = new DefaultUIRenderer();
const sessions = [];
const listenerCounts = new Map();

function countListeners(element) {
  const counts = { added: {}, removed: {} };
  const add = element.addEventListener.bind(element);
  const remove = element.removeEventListener.bind(element);
  element.addEventListener = (type, listener, options) => {
    counts.added[type] = (counts.added[type] ?? 0) + 1;
    return add(type, listener, options);
  };
  element.removeEventListener = (type, listener, options) => {
    counts.removed[type] = (counts.removed[type] ?? 0) + 1;
    return remove(type, listener, options);
  };
  listenerCounts.set(element.id, counts);
}

globalThis.RenderifyHarness = {
  events: [],
  async mount(plan, mountId) {
    const element = document.getElementById(mountId);
    countListeners(element);
    const session = await createInteractiveSession(plan, {
      ui,
      target: {
        element,
        onRuntimeEvent: ({ event }) => {
          globalThis.RenderifyHarness.events.push(event);
        },
      },
      runtimeOptions: { enableDependencyPreflight: false },
    });
    sessions.push(session);
    return session.security.safe;
  },
  state(index = 0) {
    return sessions[index]?.getState();
  },
  dispose(mountId) {
    ui.disposeTarget(document.getElementById(mountId));
    return listenerCounts.get(mountId);
  },
};
`;

async function bundleHarness(): Promise<string> {
  const result = await build({
    stdin: {
      contents: HARNESS_SOURCE,
      resolveDir: REPO_ROOT,
      sourcefile: "interaction-harness.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    alias: {
      "@renderify/ir": path.join(REPO_ROOT, "packages/ir/src/index.ts"),
      "@renderify/security": path.join(
        REPO_ROOT,
        "packages/security/src/index.ts",
      ),
      "@renderify/runtime": path.join(
        REPO_ROOT,
        "packages/runtime/src/index.ts",
      ),
    },
  });
  const [output] = result.outputFiles;
  assert.ok(output, "harness bundle was not produced");
  return output.text;
}

const TODO_PLAN: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "e2e_interaction_todos",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "section",
    children: [
      {
        type: "element",
        tag: "input",
        props: {
          id: "draft",
          bind: "draft",
          placeholder: "New task",
          onEnter: "add",
        },
      },
      {
        type: "element",
        tag: "button",
        props: { id: "add", onClick: "add" },
        children: [{ type: "text", value: "Add" }],
      },
      {
        type: "element",
        tag: "p",
        props: { id: "preview" },
        children: [{ type: "text", value: "Typing: {{state.draft}}" }],
      },
      {
        type: "element",
        tag: "ul",
        children: [
          {
            type: "each",
            items: "state.todos",
            as: "todo",
            key: "id",
            children: [
              {
                type: "element",
                tag: "li",
                props: { class: "todo" },
                children: [
                  {
                    type: "element",
                    tag: "input",
                    props: {
                      type: "checkbox",
                      class: "done",
                      bind: "todos.{{index}}.done",
                    },
                  },
                  {
                    type: "element",
                    tag: "span",
                    props: { class: "title" },
                    children: [{ type: "text", value: "{{todo.title}}" }],
                  },
                  {
                    type: "if",
                    when: "todo.done",
                    children: [{ type: "text", value: " ✓" }],
                  },
                  {
                    type: "element",
                    tag: "button",
                    props: {
                      class: "remove",
                      onClick: {
                        type: "remove",
                        payload: { index: "{{index}}" },
                      },
                    },
                    children: [{ type: "text", value: "Remove" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "if",
        when: "state.todos",
        not: true,
        children: [
          {
            type: "element",
            tag: "p",
            props: { id: "empty" },
            children: [{ type: "text", value: "Nothing to do" }],
          },
        ],
      },
    ],
  },
  state: {
    initial: {
      draft: "",
      nextId: 2,
      todos: [{ id: 1, title: "Write docs", done: false }],
    },
    transitions: {
      add: [
        {
          type: "push",
          path: "todos",
          value: {
            id: { $from: "state.nextId" },
            title: { $from: "state.draft" },
            done: false,
          },
        },
        { type: "increment", path: "nextId" },
        { type: "set", path: "draft", value: "" },
      ],
      remove: [{ type: "remove", path: "todos.{{event.payload.index}}" }],
    },
  },
};

const FORM_PLAN: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "e2e_interaction_form",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "div",
    children: [
      {
        type: "element",
        tag: "select",
        props: { id: "size", onChange: "size-picked" },
        children: [
          {
            type: "element",
            tag: "option",
            props: { value: "s" },
            children: [{ type: "text", value: "Small" }],
          },
          {
            type: "element",
            tag: "option",
            props: { value: "l" },
            children: [{ type: "text", value: "Large" }],
          },
        ],
      },
      {
        type: "element",
        tag: "textarea",
        props: { id: "notes", bind: "notes" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "secret", type: "password", bind: "secret" },
      },
      {
        type: "element",
        tag: "button",
        props: {
          id: "send",
          onClick: {
            type: "tool:send",
            payload: {
              notes: { $from: "state.notes" },
              size: { $from: "state.size" },
            },
          },
        },
        children: [{ type: "text", value: "Send" }],
      },
      {
        type: "element",
        tag: "p",
        props: { id: "picked" },
        children: [{ type: "text", value: "Size {{state.size}}" }],
      },
    ],
  },
  state: {
    initial: { size: "s", notes: "Initial notes" },
    transitions: {
      "size-picked": [
        { type: "set", path: "size", value: { $from: "event.payload.value" } },
      ],
    },
  },
};

const SEARCH_PLAN: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "e2e_interaction_search",
  version: 1,
  capabilities: { domWrite: true },
  root: {
    type: "element",
    tag: "form",
    props: {
      id: "search",
      method: "post",
      onSubmit: { type: "tool:search_flights", payload: { source: "form" } },
    },
    children: [
      { type: "element", tag: "input", props: { id: "from", name: "from" } },
      {
        type: "element",
        tag: "select",
        props: { id: "cabin", name: "cabin" },
        children: [
          {
            type: "element",
            tag: "option",
            props: { value: "economy" },
            children: [{ type: "text", value: "Economy" }],
          },
          {
            type: "element",
            tag: "option",
            props: { value: "business" },
            children: [{ type: "text", value: "Business" }],
          },
        ],
      },
      {
        type: "element",
        tag: "input",
        props: { id: "flexible", type: "checkbox", name: "flexible" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "ua", type: "checkbox", name: "airlines", value: "ua" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "dl", type: "checkbox", name: "airlines", value: "dl" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "nonstop", type: "radio", name: "stops", value: "0" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "onestop", type: "radio", name: "stops", value: "1" },
      },
      {
        type: "element",
        tag: "input",
        props: { id: "pin", type: "password", name: "pin" },
      },
      {
        type: "element",
        tag: "button",
        props: { id: "swap", type: "button", onClick: "swap" },
        children: [{ type: "text", value: "Swap" }],
      },
      {
        type: "element",
        tag: "button",
        props: { id: "go" },
        children: [{ type: "text", value: "Search" }],
      },
    ],
  },
  state: {
    initial: { swaps: 0 },
    transitions: { swap: [{ type: "increment", path: "swaps" }] },
  },
};

async function mountPlan(
  page: Page,
  plan: RuntimePlan,
  mountId: string,
): Promise<boolean> {
  // The plan crosses into the page as JSON text; Playwright's argument
  // typing cannot follow the recursive RuntimePlan type.
  return page.evaluate(
    ({ json, id }) =>
      (
        globalThis as unknown as {
          RenderifyHarness: {
            mount(plan: unknown, id: string): Promise<boolean>;
          };
        }
      ).RenderifyHarness.mount(JSON.parse(json), id),
    { json: JSON.stringify(plan), id: mountId },
  );
}

async function openHarness(browser: Browser, bundle: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(
    '<main><div id="todos"></div><div id="form"></div><div id="search-mount"></div></main>',
  );
  await page.addScriptTag({ content: bundle });
  return page;
}

test("e2e: declarative lists, conditions, and bound inputs stay interactive", async (t) => {
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

    const page = await openHarness(browser, await bundleHarness());
    assert.equal(await mountPlan(page, TODO_PLAN, "todos"), true);
    await page.locator("li.todo").first().waitFor();

    // Typing updates bound state on every keystroke without losing input.
    await page.locator("#draft").pressSequentially("Buy milk", { delay: 5 });
    await page.locator("#preview", { hasText: "Typing: Buy milk" }).waitFor();
    assert.equal(await page.locator("#draft").inputValue(), "Buy milk");

    // Enter adds the item and clears the still-focused field.
    await page.locator("#draft").press("Enter");
    await page.locator("li.todo", { hasText: "Buy milk" }).waitFor();
    await page.waitForFunction(
      () => (document.getElementById("draft") as HTMLInputElement).value === "",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "draft",
    );

    // Clicking Add clears the field the same way.
    await page.locator("#draft").fill("Walk dog");
    await page.locator("#add").click();
    await page.locator("li.todo", { hasText: "Walk dog" }).waitFor();
    assert.equal(await page.locator("#draft").inputValue(), "");
    assert.deepEqual(await page.locator("li.todo .title").allTextContents(), [
      "Write docs",
      "Buy milk",
      "Walk dog",
    ]);

    // A bound checkbox inside the loop writes to its own item.
    await page
      .locator("li.todo", { hasText: "Buy milk" })
      .locator(".done")
      .check();
    await page.locator("li.todo", { hasText: "Buy milk ✓" }).waitFor();
    const doneFlags = await page.evaluate(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: {
            state(): { todos: Array<{ done: boolean }> };
          };
        }
      ).RenderifyHarness.state().todos.map((todo) => todo.done),
    );
    assert.deepEqual(doneFlags, [false, true, false]);

    // Keyed items keep their DOM nodes when an earlier item is removed.
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("li.todo"));
      const walk = items.find((item) => item.textContent?.includes("Walk dog"));
      (walk as unknown as { __marker?: string }).__marker = "kept";
    });
    await page
      .locator("li.todo", { hasText: "Write docs" })
      .locator(".remove")
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("li.todo").length === 2,
    );
    const marker = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("li.todo"));
      const walk = items.find((item) => item.textContent?.includes("Walk dog"));
      return (walk as unknown as { __marker?: string } | undefined)?.__marker;
    });
    assert.equal(marker, "kept");
    assert.equal(
      await page
        .locator("li.todo", { hasText: "Buy milk" })
        .locator(".done")
        .isChecked(),
      true,
    );

    // Removing the rest switches the "if" branch to the empty state.
    await page.locator("li.todo .remove").first().click();
    await page.waitForFunction(
      () => document.querySelectorAll("li.todo").length === 1,
    );
    await page.locator("li.todo .remove").first().click();
    await page.locator("#empty", { hasText: "Nothing to do" }).waitFor();
  } finally {
    await browser?.close();
  }
});

test("e2e: control events carry live values and payload references resolve at dispatch", async (t) => {
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

    const page = await openHarness(browser, await bundleHarness());
    assert.equal(await mountPlan(page, FORM_PLAN, "form"), true);
    await page.locator("#picked", { hasText: "Size s" }).waitFor();

    // A bound textarea shows its state value.
    assert.equal(await page.locator("#notes").inputValue(), "Initial notes");

    // A select's change event carries its live value into transitions.
    await page.locator("#size").selectOption("l");
    await page.locator("#picked", { hasText: "Size l" }).waitFor();

    // Password inputs are never bound or captured.
    await page.locator("#secret").fill("hunter2");
    await page.locator("#notes").fill("Ship it");
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            RenderifyHarness: { state(): { notes?: string } };
          }
        ).RenderifyHarness.state()?.notes === "Ship it",
    );

    // Payload references read state when the click is handled, so the host
    // (for example an MCP tool call) receives what the user just typed.
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: { events: Array<{ type: string }> };
        }
      ).RenderifyHarness.events.some((event) => event.type === "tool:send"),
    );
    const events = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            RenderifyHarness: { events: RuntimeEvent[] };
          }
        ).RenderifyHarness.events,
    );
    const send = events.find((event) => event.type === "tool:send");
    assert.deepEqual(send?.payload, { notes: "Ship it", size: "l" });
    const picked = events.find((event) => event.type === "size-picked");
    assert.equal(picked?.payload?.value, "l");
    assert.doesNotMatch(JSON.stringify(events), /hunter2/);
    const state = await page.evaluate(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: { state(): Record<string, unknown> };
        }
      ).RenderifyHarness.state(),
    );
    assert.equal(state.secret, undefined);
  } finally {
    await browser?.close();
  }
});

test("e2e: forms render inert, emulate submit, and release their listeners", async (t) => {
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

    const page = await openHarness(browser, await bundleHarness());
    assert.equal(await mountPlan(page, SEARCH_PLAN, "search-mount"), true);
    await page.locator("#search[data-renderify-form]").waitFor();
    assert.equal(await page.locator("form").count(), 0);
    assert.equal(await page.locator("#search").getAttribute("method"), null);

    await page.locator("#from").fill("SFO");
    await page.locator("#cabin").selectOption("business");
    await page.locator("#flexible").check();
    await page.locator("#ua").check();
    await page.locator("#nonstop").check();
    await page.locator("#pin").fill("1234");

    const readEvents = () =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              RenderifyHarness: { events: RuntimeEvent[] };
            }
          ).RenderifyHarness.events,
      );
    const submits = async () =>
      (await readEvents()).filter(
        (event) => event.type === "tool:search_flights",
      );

    // A type="button" button never submits.
    await page.locator("#swap").click();
    await page.waitForFunction(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: { events: Array<{ type: string }> };
        }
      ).RenderifyHarness.events.some((event) => event.type === "swap"),
    );
    assert.equal((await submits()).length, 0);

    const expected = {
      from: "SFO",
      cabin: "business",
      flexible: true,
      airlines: ["ua"],
      stops: "0",
      source: "form",
    };

    // Enter in a text field submits with the named fields.
    await page.locator("#from").press("Enter");
    await page.waitForFunction(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: { events: Array<{ type: string }> };
        }
      ).RenderifyHarness.events.some(
        (event) => event.type === "tool:search_flights",
      ),
    );
    assert.deepEqual((await submits())[0]?.payload, expected);

    // So does the default (submit) button.
    await page.locator("#go").click();
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            RenderifyHarness: { events: Array<{ type: string }> };
          }
        ).RenderifyHarness.events.filter(
          (event) => event.type === "tool:search_flights",
        ).length === 2,
    );
    assert.deepEqual((await submits())[1]?.payload, expected);
    assert.doesNotMatch(JSON.stringify(await readEvents()), /1234/);
    assert.equal(page.url(), "about:blank");

    // Disposing the mount removes every delegated listener it added.
    const counts = (await page.evaluate(() =>
      (
        globalThis as unknown as {
          RenderifyHarness: { dispose(id: string): unknown };
        }
      ).RenderifyHarness.dispose("search-mount"),
    )) as {
      added: Record<string, number>;
      removed: Record<string, number>;
    };
    assert.ok((counts.added.click ?? 0) >= 1);
    assert.ok((counts.added.keydown ?? 0) >= 1);
    assert.deepEqual(counts.removed, counts.added);
  } finally {
    await browser?.close();
  }
});
