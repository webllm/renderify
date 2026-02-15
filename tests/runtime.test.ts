import assert from "node:assert/strict";
import test from "node:test";
import {
  createComponentNode,
  createElementNode,
  createTextNode,
  DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
  type RuntimeModuleManifest,
  type RuntimeNode,
  type RuntimePlan,
} from "../packages/ir/src/index";
import {
  DefaultRuntimeManager,
  JspmModuleLoader,
  type RuntimeComponentFactory,
  type RuntimeModuleLoader,
  RuntimeSecurityViolationError,
  type RuntimeSourceTranspileInput,
  type RuntimeSourceTranspiler,
  renderPlanInBrowser,
} from "../packages/runtime/src/index";

class MockLoader implements RuntimeModuleLoader {
  constructor(private readonly modules: Record<string, unknown>) {}

  async load(specifier: string): Promise<unknown> {
    if (!(specifier in this.modules)) {
      throw new Error(`missing module: ${specifier}`);
    }
    return this.modules[specifier];
  }
}

class PassthroughSourceTranspiler implements RuntimeSourceTranspiler {
  async transpile(input: RuntimeSourceTranspileInput): Promise<string> {
    return input.code;
  }
}

class ResolveOnlyLoader implements RuntimeModuleLoader {
  async load(_specifier: string): Promise<unknown> {
    return {};
  }

  resolveSpecifier(specifier: string): string {
    if (specifier === "virtual:msg") {
      return `data:text/javascript,${encodeURIComponent(
        "export default 'from-jspm-resolver';",
      )}`;
    }

    return specifier;
  }
}

class FailingLoader implements RuntimeModuleLoader {
  async load(specifier: string): Promise<unknown> {
    throw new Error(`preflight reject: ${specifier}`);
  }
}

type WorkerMessageHandler = (event: MessageEvent<unknown>) => void;
type WorkerErrorHandler = (event: ErrorEvent) => void;

class SandboxSuccessWorker {
  private readonly messageHandlers = new Set<WorkerMessageHandler>();
  private readonly errorHandlers = new Set<WorkerErrorHandler>();
  terminated = false;

  constructor(_url: string, _options?: { type?: string; name?: string }) {}

  addEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.add(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.add(handler as WorkerErrorHandler);
    }
  }

  removeEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.delete(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.delete(handler as WorkerErrorHandler);
    }
  }

  postMessage(payload: unknown): void {
    const request = payload as {
      id?: string;
      runtimeInput?: {
        state?: {
          count?: number;
        };
      };
    };
    const count = request.runtimeInput?.state?.count ?? 0;
    const response = {
      renderifySandbox: "runtime-source",
      id: request.id,
      ok: true,
      output: {
        type: "element",
        tag: "section",
        children: [{ type: "text", value: `sandbox-count:${count}` }],
      },
    };

    queueMicrotask(() => {
      for (const handler of this.messageHandlers) {
        handler({ data: response } as MessageEvent<unknown>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class SandboxFailWorker {
  private readonly messageHandlers = new Set<WorkerMessageHandler>();
  private readonly errorHandlers = new Set<WorkerErrorHandler>();

  constructor(_url: string, _options?: { type?: string; name?: string }) {}

  addEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.add(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.add(handler as WorkerErrorHandler);
    }
  }

  removeEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.delete(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.delete(handler as WorkerErrorHandler);
    }
  }

  postMessage(payload: unknown): void {
    const request = payload as {
      id?: string;
    };

    queueMicrotask(() => {
      for (const handler of this.messageHandlers) {
        handler({
          data: {
            renderifySandbox: "runtime-source",
            id: request.id,
            ok: false,
            error: "sandbox exploded",
          },
        } as MessageEvent<unknown>);
      }
    });
  }

  terminate(): void {}
}

class SandboxDelayedWorker {
  static instances: SandboxDelayedWorker[] = [];

  private readonly messageHandlers = new Set<WorkerMessageHandler>();
  private readonly errorHandlers = new Set<WorkerErrorHandler>();
  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  terminated = false;

  constructor(_url: string, _options?: { type?: string; name?: string }) {
    SandboxDelayedWorker.instances.push(this);
  }

  static reset(): void {
    SandboxDelayedWorker.instances = [];
  }

  addEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.add(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.add(handler as WorkerErrorHandler);
    }
  }

  removeEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.delete(handler as WorkerMessageHandler);
      return;
    }
    if (type === "error") {
      this.errorHandlers.delete(handler as WorkerErrorHandler);
    }
  }

  postMessage(payload: unknown): void {
    const request = payload as {
      id?: string;
    };

    this.responseTimer = setTimeout(() => {
      if (this.terminated) {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler({
          data: {
            renderifySandbox: "runtime-source",
            id: request.id,
            ok: true,
            output: { type: "text", value: "late-response" },
          },
        } as MessageEvent<unknown>);
      }
    }, 300);
  }

  terminate(): void {
    this.terminated = true;
    if (this.responseTimer !== undefined) {
      clearTimeout(this.responseTimer);
    }
  }
}

function installBrowserSandboxGlobals(workerCtor: unknown): () => void {
  const root = globalThis as Record<string, unknown>;
  const urlStatics = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };

  const previousWindow = Object.getOwnPropertyDescriptor(root, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(root, "document");
  const previousNavigator = Object.getOwnPropertyDescriptor(root, "navigator");
  const previousWorker = Object.getOwnPropertyDescriptor(root, "Worker");
  const previousCreateObjectURL = urlStatics.createObjectURL;
  const previousRevokeObjectURL = urlStatics.revokeObjectURL;

  Object.defineProperty(root, "window", {
    configurable: true,
    writable: true,
    value: {} as Window,
  });
  Object.defineProperty(root, "document", {
    configurable: true,
    writable: true,
    value: {} as Document,
  });
  Object.defineProperty(root, "navigator", {
    configurable: true,
    writable: true,
    value: {} as Navigator,
  });
  Object.defineProperty(root, "Worker", {
    configurable: true,
    writable: true,
    value: workerCtor,
  });

  Object.defineProperty(urlStatics, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:runtime-test",
  });
  Object.defineProperty(urlStatics, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => {},
  });

  return () => {
    restoreDescriptor(root, "window", previousWindow);
    restoreDescriptor(root, "document", previousDocument);
    restoreDescriptor(root, "navigator", previousNavigator);
    restoreDescriptor(root, "Worker", previousWorker);
    restoreDescriptor(
      urlStatics as unknown as Record<string, unknown>,
      "createObjectURL",
      previousCreateObjectURL
        ? {
            configurable: true,
            writable: true,
            value: previousCreateObjectURL,
          }
        : undefined,
    );
    restoreDescriptor(
      urlStatics as unknown as Record<string, unknown>,
      "revokeObjectURL",
      previousRevokeObjectURL
        ? {
            configurable: true,
            writable: true,
            value: previousRevokeObjectURL,
          }
        : undefined,
    );
  };
}

function installBrowserIframeSandboxGlobals(): () => void {
  const root = globalThis as Record<string, unknown>;
  const urlStatics = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };

  const previousWindow = Object.getOwnPropertyDescriptor(root, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(root, "document");
  const previousNavigator = Object.getOwnPropertyDescriptor(root, "navigator");
  const previousWorker = Object.getOwnPropertyDescriptor(root, "Worker");
  const previousCreateObjectURL = urlStatics.createObjectURL;
  const previousRevokeObjectURL = urlStatics.revokeObjectURL;

  const windowMessageHandlers = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  const mockWindow = {
    addEventListener(type: string, handler: EventListener): void {
      if (type === "message") {
        windowMessageHandlers.add(
          handler as (event: MessageEvent<unknown>) => void,
        );
      }
    },
    removeEventListener(type: string, handler: EventListener): void {
      if (type === "message") {
        windowMessageHandlers.delete(
          handler as (event: MessageEvent<unknown>) => void,
        );
      }
    },
    dispatchMessage(event: MessageEvent<unknown>): void {
      for (const handler of windowMessageHandlers) {
        handler(event);
      }
    },
  } as unknown as Window & {
    dispatchMessage(event: MessageEvent<unknown>): void;
  };

  class MockIframeElement {
    private readonly loadHandlers = new Set<EventListener>();
    readonly style: Record<string, string> = {};
    srcdoc = "";
    contentWindow: {
      postMessage: (payload: unknown, targetOrigin: string) => void;
    };

    constructor() {
      const contentWindowRef = {
        postMessage: (payload: unknown) => {
          const requestPayload = payload as {
            channel?: string;
            request?: {
              runtimeInput?: {
                state?: {
                  count?: number;
                };
              };
            };
          };
          const count = requestPayload.request?.runtimeInput?.state?.count ?? 0;
          queueMicrotask(() => {
            mockWindow.dispatchMessage({
              source: contentWindowRef,
              data: {
                channel: requestPayload.channel,
                ok: true,
                output: {
                  type: "element",
                  tag: "article",
                  children: [
                    {
                      type: "text",
                      value: `iframe-sandbox-count:${count}`,
                    },
                  ],
                },
              },
            } as MessageEvent<unknown>);
          });
        },
      };
      this.contentWindow = contentWindowRef;
    }

    setAttribute(_name: string, _value: string): void {}

    addEventListener(type: string, handler: EventListener): void {
      if (type === "load") {
        this.loadHandlers.add(handler);
      }
    }

    removeEventListener(type: string, handler: EventListener): void {
      if (type === "load") {
        this.loadHandlers.delete(handler);
      }
    }

    remove(): void {}

    dispatchLoad(): void {
      for (const handler of this.loadHandlers) {
        handler({} as Event);
      }
    }
  }

  const mockDocument = {
    createElement(tag: string) {
      if (tag !== "iframe") {
        throw new Error(`Unexpected element request: ${tag}`);
      }
      return new MockIframeElement();
    },
    body: {
      appendChild(element: unknown) {
        queueMicrotask(() => {
          (element as MockIframeElement).dispatchLoad();
        });
      },
    },
  } as unknown as Document;

  Object.defineProperty(root, "window", {
    configurable: true,
    writable: true,
    value: mockWindow,
  });
  Object.defineProperty(root, "document", {
    configurable: true,
    writable: true,
    value: mockDocument,
  });
  Object.defineProperty(root, "navigator", {
    configurable: true,
    writable: true,
    value: {} as Navigator,
  });
  Object.defineProperty(root, "Worker", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  Object.defineProperty(urlStatics, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:runtime-test",
  });
  Object.defineProperty(urlStatics, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => {},
  });

  return () => {
    restoreDescriptor(root, "window", previousWindow);
    restoreDescriptor(root, "document", previousDocument);
    restoreDescriptor(root, "navigator", previousNavigator);
    restoreDescriptor(root, "Worker", previousWorker);
    restoreDescriptor(
      urlStatics as unknown as Record<string, unknown>,
      "createObjectURL",
      previousCreateObjectURL
        ? {
            configurable: true,
            writable: true,
            value: previousCreateObjectURL,
          }
        : undefined,
    );
    restoreDescriptor(
      urlStatics as unknown as Record<string, unknown>,
      "revokeObjectURL",
      previousRevokeObjectURL
        ? {
            configurable: true,
            writable: true,
            value: previousRevokeObjectURL,
          }
        : undefined,
    );
  };
}

function restoreDescriptor(
  target: Record<string, unknown>,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  delete target[key];
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createPlan(root: RuntimeNode, imports: string[] = []): RuntimePlan {
  const moduleManifest: RuntimeModuleManifest = {};
  for (const specifier of imports) {
    moduleManifest[specifier] = {
      resolvedUrl: specifier,
      signer: "tests",
    };
  }

  return {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_test_plan",
    version: 1,
    root,
    imports,
    moduleManifest:
      Object.keys(moduleManifest).length > 0 ? moduleManifest : undefined,
    capabilities: {
      domWrite: true,
    },
  };
}

test("renderPlanInBrowser renders runtime node HTML without mount target", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "embed_runtime_plan",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("hello")]),
    capabilities: {
      domWrite: true,
    },
  };

  const result = await renderPlanInBrowser(plan, {
    runtimeOptions: {
      browserSourceSandboxMode: "none",
    },
  });

  assert.match(result.html, /<section>/);
  assert.match(result.html, /hello/);
  assert.equal(result.security.safe, true);
});

test("renderPlanInBrowser rejects plan when security policy fails", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "embed_runtime_blocked",
    version: 1,
    root: createElementNode("script", undefined, [createTextNode("bad")]),
    capabilities: {
      domWrite: true,
    },
  };

  await assert.rejects(
    () =>
      renderPlanInBrowser(plan, {
        runtimeOptions: {
          browserSourceSandboxMode: "none",
        },
      }),
    (error: unknown) => error instanceof RuntimeSecurityViolationError,
  );
});

test("renderPlanInBrowser serializes concurrent renders for the same target", async () => {
  const planA: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "embed_runtime_serial_a",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("A")]),
    capabilities: {
      domWrite: true,
    },
  };
  const planB: RuntimePlan = {
    ...planA,
    id: "embed_runtime_serial_b",
    root: createElementNode("section", undefined, [createTextNode("B")]),
  };

  const root = globalThis as Record<string, unknown>;
  const previousDocument = Object.getOwnPropertyDescriptor(root, "document");
  const mountPoint = { innerHTML: "" } as HTMLElement;

  Object.defineProperty(root, "document", {
    configurable: true,
    writable: true,
    value: {
      querySelector: () => mountPoint,
    } as unknown as Document,
  });

  let activeRenders = 0;
  let maxConcurrentRenders = 0;
  const observedOrder: string[] = [];

  const runtime = {
    initialize: async () => {},
    terminate: async () => {},
    probePlan: async () => ({
      planId: "test",
      diagnostics: [],
      dependencies: [],
    }),
    executePlan: async () => {
      throw new Error("not used in this test");
    },
    execute: async (input: { plan: RuntimePlan }) => {
      observedOrder.push(`start:${input.plan.id}`);
      activeRenders += 1;
      maxConcurrentRenders = Math.max(maxConcurrentRenders, activeRenders);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      activeRenders -= 1;
      observedOrder.push(`end:${input.plan.id}`);
      return {
        planId: input.plan.id,
        root: input.plan.root,
        diagnostics: [],
      };
    },
    compile: async () => "",
    getPlanState: () => undefined,
    setPlanState: () => {},
    clearPlanState: () => {},
  } as unknown as DefaultRuntimeManager;

  const ui = {
    render: async () => "<section>ok</section>",
    renderNode: () => "<section>ok</section>",
  };

  const security = {
    initialize: () => {},
    checkPlan: () => ({
      safe: true,
      issues: [],
      diagnostics: [],
    }),
  } as any;

  try {
    await Promise.all([
      renderPlanInBrowser(planA, {
        target: "#app",
        runtime,
        ui,
        security,
        autoInitializeRuntime: false,
        autoTerminateRuntime: false,
      }),
      renderPlanInBrowser(planB, {
        target: "#app",
        runtime,
        ui,
        security,
        autoInitializeRuntime: false,
        autoTerminateRuntime: false,
      }),
    ]);
  } finally {
    restoreDescriptor(root, "document", previousDocument);
  }

  assert.equal(maxConcurrentRenders, 1);
  assert.deepEqual(observedOrder, [
    "start:embed_runtime_serial_a",
    "end:embed_runtime_serial_a",
    "start:embed_runtime_serial_b",
    "end:embed_runtime_serial_b",
  ]);
});

test("runtime resolves component nodes through module loader", async () => {
  const component: RuntimeComponentFactory = (props) => {
    return createElementNode("div", { class: "card" }, [
      createTextNode(String(props.title ?? "untitled")),
    ]);
  };

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/card": {
        default: component,
      },
    }),
  });

  await runtime.initialize();

  const plan = createPlan(
    createComponentNode("npm:acme/card", "default", {
      title: "Hello",
    }),
    ["npm:acme/card"],
  );

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }

  assert.equal(result.root.tag, "div");
  assert.equal(result.diagnostics.length, 0);

  await runtime.terminate();
});

test("runtime reports warning when no loader is configured", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan = createPlan(createComponentNode("npm:acme/card"), [
    "npm:acme/card",
  ]);
  const result = await runtime.executePlan(plan);

  assert.ok(
    result.diagnostics.some((item) => item.code === "RUNTIME_LOADER_MISSING"),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_COMPONENT_SKIPPED",
    ),
  );

  await runtime.terminate();
});

test("runtime keeps initial state and ignores declarative transitions", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_stateful_plan",
    version: 1,
    root: createElementNode("p", undefined, [
      createTextNode(
        "Count={{state.count}} Last={{state.last}} Actor={{state.actor}}",
      ),
    ]),
    capabilities: {
      domWrite: true,
      maxExecutionMs: 500,
    },
    state: {
      initial: {
        count: 0,
        last: 0,
        actor: "",
      },
      transitions: {
        increment: [
          { type: "increment", path: "count", by: 1 },
          {
            type: "set",
            path: "last",
            value: { $from: "event.payload.delta" },
          },
          { type: "set", path: "actor", value: { $from: "context.userId" } },
        ],
      },
    },
  };

  const result = await runtime.executePlan(
    plan,
    {
      userId: "user_42",
    },
    {
      type: "increment",
      payload: {
        delta: 3,
      },
    },
  );

  assert.deepEqual(
    result.appliedActions?.map((item) => item.type),
    [],
  );
  assert.equal(result.state?.count, 0);
  assert.equal(result.state?.last, 0);
  assert.equal(result.state?.actor, "");
  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  const textNode = result.root.children?.[0];
  assert.equal(textNode?.type, "text");
  if (!textNode || textNode.type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(textNode.value, "Count=0 Last=0 Actor=");

  await runtime.terminate();
});

test("runtime enforces maxImports capability", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/first": { default: () => createTextNode("ok") },
      "npm:acme/second": { default: () => createTextNode("ok") },
    }),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_import_cap_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("hello")]),
    imports: ["npm:acme/first", "npm:acme/second"],
    moduleManifest: {
      "npm:acme/first": { resolvedUrl: "npm:acme/first", signer: "tests" },
      "npm:acme/second": { resolvedUrl: "npm:acme/second", signer: "tests" },
    },
    capabilities: {
      domWrite: true,
      maxImports: 1,
    },
  };

  const result = await runtime.executePlan(plan);

  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_IMPORT_LIMIT_EXCEEDED",
    ),
  );

  await runtime.terminate();
});

test("runtime supports isolated-vm execution profile for sync components", async () => {
  const isolatedComponent: RuntimeComponentFactory = (props) => ({
    type: "element",
    tag: "span",
    children: [{ type: "text", value: String(props.label ?? "iso") }],
  });

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/iso": {
        default: isolatedComponent,
      },
    }),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_isolated_profile_plan",
    version: 1,
    root: createComponentNode("npm:acme/iso", "default", {
      label: "isolated",
    }),
    imports: ["npm:acme/iso"],
    moduleManifest: {
      "npm:acme/iso": { resolvedUrl: "npm:acme/iso", signer: "tests" },
    },
    capabilities: {
      domWrite: true,
      executionProfile: "isolated-vm",
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.equal(result.root.tag, "span");
  assert.equal(result.diagnostics.length, 0);

  await runtime.terminate();
});

test("runtime isolated-vm profile rejects async component factories", async () => {
  const asyncComponent: RuntimeComponentFactory = async () => ({
    type: "text",
    value: "async",
  });

  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/async-iso": {
        default: asyncComponent,
      },
    }),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_isolated_async_plan",
    version: 1,
    root: createComponentNode("npm:acme/async-iso"),
    imports: ["npm:acme/async-iso"],
    moduleManifest: {
      "npm:acme/async-iso": {
        resolvedUrl: "npm:acme/async-iso",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
      executionProfile: "isolated-vm",
    },
  };

  const result = await runtime.executePlan(plan);

  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_COMPONENT_EXEC_FAILED",
    ),
  );

  await runtime.terminate();
});

test("runtime executes source module export using custom transpiler", async () => {
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_source_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 7,
      },
    },
    source: {
      language: "js",
      code: [
        "export default ({ state }) => ({",
        '  type: "element",',
        '  tag: "p",',
        "  children: [{ type: 'text', value: `Count=${state.count}` }],",
        "});",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.equal(result.root.tag, "p");
  assert.equal(result.root.children?.[0]?.type, "text");
  if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(result.root.children[0].value, "Count=7");

  await runtime.terminate();
});

test("runtime executes source modules inside worker sandbox in browser mode", async () => {
  const restoreGlobals = installBrowserSandboxGlobals(SandboxSuccessWorker);
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "worker",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_worker_sandbox_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      state: {
        initial: {
          count: 12,
        },
      },
      source: {
        language: "js",
        code: "this is not valid js but worker mock handles it",
      },
    };

    const result = await runtime.executePlan(plan);
    assert.equal(result.root.type, "element");
    if (result.root.type !== "element") {
      throw new Error("expected element root");
    }
    assert.equal(result.root.children?.[0]?.type, "text");
    if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
      throw new Error("expected text child");
    }
    assert.equal(result.root.children[0].value, "sandbox-count:12");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_SOURCE_SANDBOX_EXECUTED",
      ),
    );
  } finally {
    await runtime.terminate();
    restoreGlobals();
  }
});

test("runtime falls back to iframe sandbox when worker is unavailable", async () => {
  const restoreGlobals = installBrowserIframeSandboxGlobals();
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "worker",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_worker_iframe_fallback_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      state: {
        initial: {
          count: 21,
        },
      },
      source: {
        language: "js",
        code: "this is not valid js but iframe mock handles it",
      },
    };

    const result = await runtime.executePlan(plan);

    assert.equal(result.root.type, "element");
    if (result.root.type !== "element") {
      throw new Error("expected element root");
    }
    assert.equal(result.root.tag, "article");
    assert.equal(result.root.children?.[0]?.type, "text");
    if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
      throw new Error("expected text child");
    }
    assert.equal(result.root.children[0].value, "iframe-sandbox-count:21");
    assert.ok(
      result.diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_SANDBOX_EXECUTED" &&
          item.message.includes("iframe sandbox"),
      ),
    );
  } finally {
    await runtime.terminate();
    restoreGlobals();
  }
});

test("runtime falls back to worker sandbox when iframe is unavailable", async () => {
  const restoreGlobals = installBrowserSandboxGlobals(SandboxSuccessWorker);
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "iframe",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_iframe_worker_fallback_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      state: {
        initial: {
          count: 33,
        },
      },
      source: {
        language: "js",
        code: "this is not valid js but worker mock handles it",
      },
    };

    const result = await runtime.executePlan(plan);

    assert.equal(result.root.type, "element");
    if (result.root.type !== "element") {
      throw new Error("expected element root");
    }
    assert.equal(result.root.children?.[0]?.type, "text");
    if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
      throw new Error("expected text child");
    }
    assert.equal(result.root.children[0].value, "sandbox-count:33");
    assert.ok(
      result.diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_SANDBOX_EXECUTED" &&
          item.message.includes("worker sandbox"),
      ),
    );
  } finally {
    await runtime.terminate();
    restoreGlobals();
  }
});

test("runtime sandbox fail-closed keeps fallback root and reports diagnostics", async () => {
  const restoreGlobals = installBrowserSandboxGlobals(SandboxFailWorker);
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "worker",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_worker_sandbox_fail_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      source: {
        language: "js",
        code: "export default () => ({ type: 'text', value: 'should-not-run' });",
      },
    };

    const result = await runtime.executePlan(plan);
    assert.equal(result.root.type, "element");
    if (result.root.type !== "element") {
      throw new Error("expected element root");
    }
    assert.equal(result.root.children?.[0]?.type, "text");
    if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
      throw new Error("expected text child");
    }
    assert.equal(result.root.children[0].value, "fallback");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_SOURCE_SANDBOX_FAILED",
      ),
    );
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_SOURCE_EXEC_FAILED",
      ),
    );
  } finally {
    await runtime.terminate();
    restoreGlobals();
  }
});

test("runtime worker sandbox execution is abortable", async () => {
  SandboxDelayedWorker.reset();
  const restoreGlobals = installBrowserSandboxGlobals(SandboxDelayedWorker);
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "worker",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_worker_sandbox_abort_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      source: {
        language: "js",
        code: "export default () => ({ type: 'text', value: 'should-not-run' });",
      },
    };

    const controller = new AbortController();
    const pending = runtime.execute({
      plan,
      signal: controller.signal,
    });

    await waitForCondition(
      () => SandboxDelayedWorker.instances.length > 0,
      400,
    );
    controller.abort();

    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.ok(
      SandboxDelayedWorker.instances.length > 0,
      "expected worker sandbox instance",
    );
    assert.ok(
      SandboxDelayedWorker.instances.every((worker) => worker.terminated),
      "expected worker sandbox instances to terminate after abort",
    );
  } finally {
    await runtime.terminate();
    restoreGlobals();
    SandboxDelayedWorker.reset();
  }
});

test("runtime rewrites source imports through module loader resolver", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new ResolveOnlyLoader(),
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_source_import_rewrite_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      code: [
        'import msg from "virtual:msg";',
        "export default () => ({",
        '  type: "text",',
        "  value: msg,",
        "});",
      ].join("\n"),
    },
    moduleManifest: {
      "virtual:msg": {
        resolvedUrl: "virtual:msg",
        signer: "tests",
      },
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "text");
  if (result.root.type !== "text") {
    throw new Error("expected text root");
  }
  assert.equal(result.root.value, "from-jspm-resolver");

  await runtime.terminate();
});

test("runtime resolves react jsx-runtime through jspm compatibility aliases", () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new JspmModuleLoader(),
  });

  const diagnostics: Array<{ message: string }> = [];
  const resolved = (
    runtime as unknown as {
      resolveRuntimeSourceSpecifier: (
        specifier: string,
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ message: string }>,
        requireManifest: boolean,
      ) => string;
    }
  ).resolveRuntimeSourceSpecifier(
    "react/jsx-runtime",
    undefined,
    diagnostics,
    false,
  );

  assert.equal(
    resolved,
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  );
});

test("runtime computes esm fallback url for jspm modules", () => {
  const runtime = new DefaultRuntimeManager();
  const fallback = (
    runtime as unknown as {
      toEsmFallbackUrl: (url: string) => string | undefined;
    }
  ).toEsmFallbackUrl("https://ga.jspm.io/npm:@mui/material@7.3.5/index.js");

  assert.equal(typeof fallback, "string");
  assert.match(
    String(fallback),
    /^https:\/\/esm\.sh\/@mui\/material@7\.3\.5\/index\.js\?/,
  );
  assert.match(String(fallback), /alias=react:preact\/compat/);
});

test("runtime computes jsdelivr and unpkg fallback urls for jspm modules", () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: ["https://cdn.jsdelivr.net", "https://unpkg.com"],
  });
  const jsdelivrFallback = (
    runtime as unknown as {
      toConfiguredFallbackUrl: (
        url: string,
        cdnBase: string,
      ) => string | undefined;
    }
  ).toConfiguredFallbackUrl(
    "https://ga.jspm.io/npm:@mui/material@7.3.5/index.js",
    "https://cdn.jsdelivr.net",
  );
  const unpkgFallback = (
    runtime as unknown as {
      toConfiguredFallbackUrl: (
        url: string,
        cdnBase: string,
      ) => string | undefined;
    }
  ).toConfiguredFallbackUrl(
    "https://ga.jspm.io/npm:@mui/material@7.3.5/index.js",
    "https://unpkg.com",
  );

  assert.equal(
    jsdelivrFallback,
    "https://cdn.jsdelivr.net/npm/@mui/material@7.3.5/index.js",
  );
  assert.equal(
    unpkgFallback,
    "https://unpkg.com/@mui/material@7.3.5/index.js?module",
  );
});

test("runtime source loader hedges fallback CDN requests", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: ["https://esm.sh"],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 1200,
  });

  const diagnostics: Array<{ code?: string }> = [];
  const loader = (
    runtime as unknown as {
      createSourceModuleLoader: (
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code?: string }>,
      ) => {
        fetchRemoteModuleCodeWithFallback(
          url: string,
        ): Promise<{ requestUrl: string }>;
      };
    }
  ).createSourceModuleLoader(undefined, diagnostics);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = String(input);

    if (requestUrl.startsWith("https://ga.jspm.io/")) {
      await new Promise((resolve) => setTimeout(resolve, 850));
      return new Response("slow-failure", { status: 503 });
    }

    if (requestUrl.startsWith("https://esm.sh/")) {
      return new Response("export default 1;", {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    return new Response("not-found", { status: 404 });
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const fetched = await loader.fetchRemoteModuleCodeWithFallback(
      "https://ga.jspm.io/npm:lit@3.3.0/index.js",
    );
    const elapsedMs = Date.now() - startedAt;

    assert.match(fetched.requestUrl, /^https:\/\/esm\.sh\//);
    assert.ok(
      elapsedMs < 500,
      `expected hedged fallback to recover quickly, got ${elapsedMs}ms`,
    );
    assert.ok(
      diagnostics.some(
        (item) => item.code === "RUNTIME_SOURCE_IMPORT_FALLBACK_USED",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader supports disabling fallback cdn attempts", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const diagnostics: Array<{ code?: string }> = [];
  const loader = (
    runtime as unknown as {
      createSourceModuleLoader: (
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code?: string }>,
      ) => {
        fetchRemoteModuleCodeWithFallback(
          url: string,
        ): Promise<{ requestUrl: string }>;
      };
    }
  ).createSourceModuleLoader(undefined, diagnostics);

  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    requestedUrls.push(requestUrl);
    return new Response("not-found", { status: 404 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      loader.fetchRemoteModuleCodeWithFallback(
        "https://ga.jspm.io/npm:lit@3.3.0/index.js",
      ),
    );

    assert.ok(
      requestedUrls.some((url) => url.startsWith("https://ga.jspm.io/")),
      "expected primary JSPM URL to be requested",
    );
    assert.equal(
      requestedUrls.some((url) => url.startsWith("https://esm.sh/")),
      false,
      "did not expect esm.sh fallback when fallback list is empty",
    );
    assert.equal(
      requestedUrls.some((url) => url.startsWith("https://cdn.jsdelivr.net/")),
      false,
      "did not expect jsdelivr fallback when fallback list is empty",
    );
    assert.equal(
      requestedUrls.some((url) => url.startsWith("https://unpkg.com/")),
      false,
      "did not expect unpkg fallback when fallback list is empty",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime enforces moduleManifest for bare component specifiers by default", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/card": {
        default: () => createTextNode("ok"),
      },
    }),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_manifest_required_plan",
    version: 1,
    root: createComponentNode("npm:acme/card"),
    capabilities: {
      domWrite: true,
    },
  };

  const result = await runtime.executePlan(plan);
  assert.ok(
    result.diagnostics.some((item) => item.code === "RUNTIME_MANIFEST_MISSING"),
  );

  await runtime.terminate();
});

test("runtime emits preact render artifact for source.runtime=preact modules", async () => {
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_preact_source_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 4,
      },
    },
    source: {
      language: "js",
      runtime: "preact",
      code: [
        "export default function Dashboard(props) {",
        '  return { type: "section", props: { "data-kind": "dashboard" },',
        "    children: [`count:${props.state.count}`] };",
        "}",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);
  assert.equal(result.renderArtifact?.mode, "preact-vnode");
  assert.ok(result.renderArtifact?.payload);

  await runtime.terminate();
});

test("runtime can fail-fast on dependency preflight import errors", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new FailingLoader(),
    failOnDependencyPreflightError: true,
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_preflight_fail_fast_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    imports: ["npm:acme/missing"],
    moduleManifest: {
      "npm:acme/missing": {
        resolvedUrl: "npm:acme/missing",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
    },
  };

  const result = await runtime.executePlan(plan);
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_PREFLIGHT_IMPORT_FAILED",
    ),
  );
  assert.ok(
    !result.diagnostics.some((item) => item.code === "RUNTIME_IMPORT_FAILED"),
  );
  assert.equal(result.root.type, "element");

  await runtime.terminate();
});

test("runtime preflight rejects unresolved relative source imports", async () => {
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    failOnDependencyPreflightError: true,
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_preflight_relative_source_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      code: [
        'import "./styles.css";',
        "export default () => ({ type: 'text', value: 'ok' });",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "RUNTIME_PREFLIGHT_SOURCE_IMPORT_RELATIVE_UNRESOLVED",
    ),
  );
  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected fallback element root");
  }
  assert.equal(result.root.children?.[0]?.type, "text");
  if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
    throw new Error("expected fallback text child");
  }
  assert.equal(result.root.children[0].value, "fallback");

  await runtime.terminate();
});

test("runtime materializes css and json remote modules into executable proxies", async () => {
  const runtime = new DefaultRuntimeManager();

  const diagnostics: Array<{ code: string; message: string; level: string }> =
    [];
  const cssProxy = await (
    runtime as unknown as {
      materializeFetchedModuleSource: (
        fetched: {
          url: string;
          code: string;
          contentType: string;
          requestUrl: string;
        },
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code: string; message: string; level: string }>,
      ) => Promise<string>;
    }
  ).materializeFetchedModuleSource(
    {
      url: "https://cdn.example.com/theme.css",
      code: "body{color:red}",
      contentType: "text/css; charset=utf-8",
      requestUrl: "https://cdn.example.com/theme.css",
    },
    undefined,
    diagnostics,
  );

  assert.match(cssProxy, /document\.createElement\("style"\)/);
  assert.match(cssProxy, /export default __css/);

  const jsonProxy = await (
    runtime as unknown as {
      materializeFetchedModuleSource: (
        fetched: {
          url: string;
          code: string;
          contentType: string;
          requestUrl: string;
        },
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code: string; message: string; level: string }>,
      ) => Promise<string>;
    }
  ).materializeFetchedModuleSource(
    {
      url: "https://cdn.example.com/data.json",
      code: '{"ok":true}',
      contentType: "application/json",
      requestUrl: "https://cdn.example.com/data.json",
    },
    undefined,
    diagnostics,
  );

  assert.match(jsonProxy, /const __json/);
  assert.equal(diagnostics.length, 0);
});

test("runtime execute rejects when aborted before execution starts", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_abort_before_start_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("abort")]),
    capabilities: {
      domWrite: true,
    },
  };

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      runtime.execute({
        plan,
        signal: controller.signal,
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  await runtime.terminate();
});

test("runtime probePlan returns dependency statuses without executing source", async () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({
      "npm:acme/chart": { default: () => createTextNode("ok") },
      "npm:acme/data": { value: 1 },
      "npm:acme/source-lib": { default: "lib" },
    }),
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_probe_plan_test",
    version: 1,
    root: createComponentNode("npm:acme/chart"),
    imports: ["npm:acme/data"],
    moduleManifest: {
      "npm:acme/chart": {
        resolvedUrl: "npm:acme/chart",
        signer: "tests",
      },
      "npm:acme/data": {
        resolvedUrl: "npm:acme/data",
        signer: "tests",
      },
      "npm:acme/source-lib": {
        resolvedUrl: "npm:acme/source-lib",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "tsx",
      code: [
        'import lib from "npm:acme/source-lib";',
        "export default function SourceView() {",
        "  return <section>{String(lib)}</section>;",
        "}",
      ].join("\n"),
    },
  };

  const probe = await runtime.probePlan(plan);
  assert.equal(probe.planId, "runtime_probe_plan_test");
  assert.equal(
    probe.dependencies.filter((item) => item.ok).length,
    probe.dependencies.length,
  );
  assert.ok(
    probe.dependencies.some(
      (item) =>
        item.usage === "component" &&
        item.specifier === "npm:acme/chart" &&
        item.resolvedSpecifier === "npm:acme/chart",
    ),
  );
  assert.ok(
    probe.dependencies.some(
      (item) =>
        item.usage === "source-import" &&
        item.specifier === "npm:acme/source-lib",
    ),
  );
  assert.ok(
    !probe.diagnostics.some(
      (item) =>
        item.code === "RUNTIME_SOURCE_EXEC_FAILED" ||
        item.code === "RUNTIME_SOURCE_EXPORT_MISSING",
    ),
  );

  await runtime.terminate();
});
