import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  createInteractiveSession,
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

class SandboxSuccessShadowRealm {
  async importValue(
    _specifier: string,
    _bindingName: string,
  ): Promise<unknown> {
    return async (serializedRuntimeInput: string) => {
      const runtimeInput = JSON.parse(serializedRuntimeInput) as {
        state?: {
          count?: number;
        };
      };
      const count = runtimeInput.state?.count ?? 0;
      return JSON.stringify({
        ok: true,
        output: {
          type: "element",
          tag: "aside",
          children: [{ type: "text", value: `shadowrealm-count:${count}` }],
        },
      });
    };
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
  const mockWindow = {} as Window;

  class MockIframeElement {
    private readonly loadHandlers = new Set<EventListener>();
    readonly style: Record<string, string> = {};
    srcdoc = "";
    contentWindow: {
      postMessage: (
        payload: unknown,
        targetOrigin: string,
        transfer?: unknown[],
      ) => void;
    };

    constructor() {
      const contentWindowRef = {
        postMessage: (
          payload: unknown,
          _targetOrigin: string,
          transfer?: unknown[],
        ) => {
          const initPayload = payload as {
            channel?: string;
            type?: string;
          };
          const port = transfer?.[0] as
            | {
                postMessage: (value: unknown) => void;
                addEventListener?: (
                  type: string,
                  listener: EventListener,
                  options?: AddEventListenerOptions,
                ) => void;
              }
            | undefined;
          if (!port || initPayload.type !== "init") {
            return;
          }

          port.addEventListener?.(
            "message",
            ((event: MessageEvent<unknown>) => {
              const executePayload = event.data as {
                type?: string;
                request?: {
                  runtimeInput?: {
                    state?: {
                      count?: number;
                    };
                  };
                };
              };
              if (executePayload.type !== "execute") {
                return;
              }
              const count =
                executePayload.request?.runtimeInput?.state?.count ?? 0;
              port.postMessage({
                type: "result",
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
              });
            }) as EventListener,
            { once: true },
          );

          queueMicrotask(() => {
            port.postMessage({
              type: "ready",
              channel: initPayload.channel,
            });
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

test("renderPlanInBrowser accepts plans without capabilities", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "embed_runtime_plan_without_capabilities",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("hello")]),
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

test("renderPlanInBrowser binds default runtime network policy to security policy", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "embed_runtime_security_network_policy",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("ok")]),
    capabilities: {
      domWrite: true,
    },
  };

  const result = await renderPlanInBrowser(plan, {
    runtimeOptions: {
      browserSourceSandboxMode: "none",
      remoteFallbackCdnBases: ["https://esm.sh"],
    },
    securityInitialization: {
      profile: "strict",
    },
  });

  const runtime = result.runtime as unknown as {
    allowArbitraryNetwork?: boolean;
    allowedNetworkHosts?: Set<string>;
  };

  assert.equal(runtime.allowArbitraryNetwork, false);
  assert.deepEqual(
    [...(runtime.allowedNetworkHosts ?? new Set<string>())].sort(),
    ["cdn.jspm.io", "ga.jspm.io"],
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
    getPolicy: () => ({
      allowArbitraryNetwork: true,
      allowedNetworkHosts: [],
    }),
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

test("createInteractiveSession auto-dispatches runtime events into transitions", async () => {
  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "interactive_session_plan",
    version: 1,
    root: createElementNode("p", undefined, [
      createTextNode("Count={{state.count}} Last={{state.last}}"),
    ]),
    capabilities: {
      domWrite: true,
    },
    state: {
      initial: {
        count: 0,
        last: 0,
      },
      transitions: {
        increment: [
          { type: "increment", path: "count", by: 1 },
          {
            type: "set",
            path: "last",
            value: { $from: "event.payload.delta" },
          },
        ],
      },
    },
  };

  const session = await createInteractiveSession(plan, {
    runtimeOptions: {
      browserSourceSandboxMode: "none",
      enableDependencyPreflight: false,
    },
  });

  try {
    const initial = session.getLastResult();
    assert.match(initial.html, /Count=0 Last=0/);
    assert.equal(initial.execution.state.count, 0);

    const dispatched = await session.dispatch({
      type: "increment",
      payload: { delta: 5 },
    });
    assert.match(dispatched.html, /Count=1 Last=5/);
    assert.equal(dispatched.execution.state.count, 1);
    assert.deepEqual(
      dispatched.execution.appliedActions?.map((action) => action.type),
      ["increment", "set"],
    );
    assert.equal(session.getState()?.count, 1);

    const manuallySet = await session.setState({
      count: 9,
      last: 9,
    });
    assert.match(manuallySet.html, /Count=9 Last=9/);

    const cleared = await session.clearState();
    assert.match(cleared.html, /Count=0 Last=0/);
  } finally {
    await session.terminate();
  }
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

test("runtime tolerates malformed child node payloads without throwing", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const malformedRoot = {
    type: "element",
    tag: "section",
    children: [
      createTextNode("ok"),
      '{"type":"text","value":"stringified"}',
      {
        type: "component",
      },
    ],
  } as unknown as RuntimeNode;

  const result = await runtime.executePlan(createPlan(malformedRoot));

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.ok(
    result.diagnostics.some((item) => item.code === "RUNTIME_NODE_INVALID"),
  );

  await runtime.terminate();
});

test("runtime tolerates malformed import specifier types", async () => {
  const runtime = new DefaultRuntimeManager();
  await runtime.initialize();

  const plan = {
    ...createPlan(createElementNode("div", undefined, [createTextNode("ok")])),
    imports: [123],
  } as unknown as RuntimePlan;

  const result = await runtime.executePlan(plan);
  assert.ok(
    result.diagnostics.some((item) => item.code === "RUNTIME_MANIFEST_INVALID"),
  );

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

test("runtime applies declarative transitions and persists plan state", async () => {
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
    ["increment", "set", "set"],
  );
  assert.equal(result.state?.count, 1);
  assert.equal(result.state?.last, 3);
  assert.equal(result.state?.actor, "user_42");
  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  const textNode = result.root.children?.[0];
  assert.equal(textNode?.type, "text");
  if (!textNode || textNode.type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(textNode.value, "Count=1 Last=3 Actor=user_42");

  const persisted = runtime.getPlanState(plan.id);
  assert.equal(persisted?.count, 1);
  assert.equal(persisted?.last, 3);
  assert.equal(persisted?.actor, "user_42");

  const secondResult = await runtime.executePlan(plan);
  assert.equal(secondResult.state?.count, 1);
  assert.equal(secondResult.state?.last, 3);
  assert.equal(secondResult.state?.actor, "user_42");

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

test("runtime falls back to default source export when exportName is missing", async () => {
  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
  });

  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_source_exportname_fallback_plan",
    version: 1,
    root: createElementNode("div", undefined, [createTextNode("fallback")]),
    capabilities: {
      domWrite: true,
    },
    source: {
      language: "js",
      exportName: "TodoApp",
      code: [
        "export default () => ({",
        '  type: "element",',
        '  tag: "section",',
        "  children: [{ type: 'text', value: 'default-export-rendered' }],",
        "});",
      ].join("\n"),
    },
  };

  const result = await runtime.executePlan(plan);

  assert.equal(result.root.type, "element");
  if (result.root.type !== "element") {
    throw new Error("expected element root");
  }
  assert.equal(result.root.tag, "section");
  assert.equal(result.root.children?.[0]?.type, "text");
  if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
    throw new Error("expected text child");
  }
  assert.equal(result.root.children[0].value, "default-export-rendered");
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "RUNTIME_SOURCE_EXPORT_FALLBACK_DEFAULT",
    ),
  );
  assert.ok(
    !result.diagnostics.some(
      (item) => item.code === "RUNTIME_SOURCE_EXPORT_MISSING",
    ),
  );

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

test("runtime executes source modules inside shadowrealm sandbox when available", async () => {
  const restoreGlobals = installBrowserSandboxGlobals(undefined);
  const root = globalThis as Record<string, unknown>;
  const previousShadowRealm = Object.getOwnPropertyDescriptor(
    root,
    "ShadowRealm",
  );
  Object.defineProperty(root, "ShadowRealm", {
    configurable: true,
    writable: true,
    value: SandboxSuccessShadowRealm,
  });

  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "shadowrealm",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_shadowrealm_sandbox_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      state: {
        initial: {
          count: 9,
        },
      },
      source: {
        language: "js",
        code: "this is not valid js but shadowrealm mock handles it",
      },
    };

    const result = await runtime.executePlan(plan);
    assert.equal(result.root.type, "element");
    if (result.root.type !== "element") {
      throw new Error("expected element root");
    }
    assert.equal(result.root.tag, "aside");
    assert.equal(result.root.children?.[0]?.type, "text");
    if (!result.root.children?.[0] || result.root.children[0].type !== "text") {
      throw new Error("expected text child");
    }
    assert.equal(result.root.children[0].value, "shadowrealm-count:9");
    assert.ok(
      result.diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_SANDBOX_EXECUTED" &&
          item.message.includes("shadowrealm sandbox"),
      ),
    );
  } finally {
    await runtime.terminate();
    restoreDescriptor(root, "ShadowRealm", previousShadowRealm);
    restoreGlobals();
  }
});

test("runtime shadowrealm mode falls back to worker sandbox when unavailable", async () => {
  const restoreGlobals = installBrowserSandboxGlobals(SandboxSuccessWorker);
  const root = globalThis as Record<string, unknown>;
  const previousShadowRealm = Object.getOwnPropertyDescriptor(
    root,
    "ShadowRealm",
  );
  Object.defineProperty(root, "ShadowRealm", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  const runtime = new DefaultRuntimeManager({
    sourceTranspiler: new PassthroughSourceTranspiler(),
    browserSourceSandboxMode: "shadowrealm",
    browserSourceSandboxFailClosed: true,
  });

  try {
    await runtime.initialize();

    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_source_shadowrealm_worker_fallback_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      state: {
        initial: {
          count: 18,
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
    assert.equal(result.root.children[0].value, "sandbox-count:18");
    assert.ok(
      result.diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_SANDBOX_EXECUTED" &&
          item.message.includes("worker sandbox"),
      ),
    );
  } finally {
    await runtime.terminate();
    restoreDescriptor(root, "ShadowRealm", previousShadowRealm);
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

test("runtime resolves preact jsx-runtime source imports without manifest entries", () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new JspmModuleLoader(),
  });

  const diagnostics: Array<{ code?: string; message: string }> = [];
  const resolved = (
    runtime as unknown as {
      resolveRuntimeSourceSpecifier: (
        specifier: string,
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code?: string; message: string }>,
        requireManifest: boolean,
      ) => string;
    }
  ).resolveRuntimeSourceSpecifier(
    "preact/jsx-runtime",
    undefined,
    diagnostics,
    true,
  );

  assert.equal(
    resolved,
    "https://ga.jspm.io/npm:preact@10.28.3/jsx-runtime/dist/jsxRuntime.module.js",
  );
  assert.equal(
    diagnostics.some((item) => item.code === "RUNTIME_MANIFEST_MISSING"),
    false,
  );
});

test("runtime source specifier fallback rewrites JSPM URLs without resolver hook", () => {
  const runtime = new DefaultRuntimeManager({
    moduleLoader: new MockLoader({}),
  });

  const diagnostics: Array<{ code?: string; message: string }> = [];
  const internals = runtime as unknown as {
    resolveRuntimeSourceSpecifier: (
      specifier: string,
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message: string }>,
      requireManifest: boolean,
    ) => string;
  };

  assert.equal(
    internals.resolveRuntimeSourceSpecifier(
      "nanoid",
      undefined,
      diagnostics,
      false,
    ),
    "https://ga.jspm.io/npm:nanoid",
  );
  assert.equal(
    internals.resolveRuntimeSourceSpecifier(
      "npm:nanoid@5",
      undefined,
      diagnostics,
      false,
    ),
    "https://ga.jspm.io/npm:nanoid@5",
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

test("runtime source loader aborts losing hedged requests after first success", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: ["https://esm.sh"],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 5000,
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

  let primaryAbortCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(input);

    if (requestUrl.startsWith("https://ga.jspm.io/")) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => {
          primaryAbortCount += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
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
    const fetched = await loader.fetchRemoteModuleCodeWithFallback(
      "https://ga.jspm.io/npm:lit@3.3.0/index.js",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(fetched.requestUrl, /^https:\/\/esm\.sh\//);
    assert.ok(
      primaryAbortCount >= 1,
      "expected primary hedged request to be aborted after fallback succeeded",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader skips fallback URLs blocked by network policy", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: ["https://esm.sh"],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 1200,
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io"],
  });

  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = (
    runtime as unknown as {
      createSourceModuleLoader: (
        moduleManifest: RuntimeModuleManifest | undefined,
        diagnostics: Array<{ code?: string; message?: string }>,
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

    if (requestUrl.startsWith("https://ga.jspm.io/")) {
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
      "did not expect blocked fallback host to be requested",
    );
    assert.ok(
      diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_IMPORT_BLOCKED" &&
          item.message?.includes("https://esm.sh/"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime blocks remote import specifiers by runtime network policy during execution", async () => {
  let loadCalls = 0;
  const runtime = new DefaultRuntimeManager({
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io"],
    moduleLoader: {
      load: async () => {
        loadCalls += 1;
        return {};
      },
    },
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_network_policy_block_import",
    version: 1,
    root: createElementNode("section", undefined, [createTextNode("blocked")]),
    imports: ["npm:lit@3.3.0"],
    moduleManifest: {
      "npm:lit@3.3.0": {
        resolvedUrl: "https://evil.example.com/npm:lit@3.3.0/index.js",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
    },
  };

  try {
    const execution = await runtime.execute({
      plan,
    });

    assert.equal(loadCalls, 0);
    assert.ok(
      execution.diagnostics.some(
        (item) => item.code === "RUNTIME_NETWORK_POLICY_BLOCKED",
      ),
    );
  } finally {
    await runtime.terminate();
  }
});

test("runtime blocks remote component modules by runtime network policy during execution", async () => {
  let loadCalls = 0;
  const runtime = new DefaultRuntimeManager({
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io"],
    moduleLoader: {
      load: async () => {
        loadCalls += 1;
        return {
          default: () => createTextNode("should not render"),
        };
      },
    },
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_network_policy_block_component",
    version: 1,
    root: createComponentNode("npm:danger/widget"),
    moduleManifest: {
      "npm:danger/widget": {
        resolvedUrl: "https://evil.example.com/npm:danger/widget/index.js",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
    },
  };

  try {
    const execution = await runtime.execute({
      plan,
    });

    assert.equal(loadCalls, 0);
    assert.ok(
      execution.diagnostics.some(
        (item) => item.code === "RUNTIME_NETWORK_POLICY_BLOCKED",
      ),
    );
  } finally {
    await runtime.terminate();
  }
});

test("runtime preflight blocks remote dependencies by runtime network policy", async () => {
  let loadCalls = 0;
  const runtime = new DefaultRuntimeManager({
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io"],
    moduleLoader: {
      load: async () => {
        loadCalls += 1;
        return {};
      },
    },
  });
  await runtime.initialize();

  const plan: RuntimePlan = {
    specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
    id: "runtime_network_policy_preflight_block",
    version: 1,
    root: createElementNode("section", undefined, [
      createTextNode("preflight"),
    ]),
    imports: ["npm:lit@3.3.0"],
    moduleManifest: {
      "npm:lit@3.3.0": {
        resolvedUrl: "https://evil.example.com/npm:lit@3.3.0/index.js",
        signer: "tests",
      },
    },
    capabilities: {
      domWrite: true,
    },
  };

  try {
    const probe = await runtime.probePlan(plan);
    assert.equal(loadCalls, 0);
    assert.ok(
      probe.diagnostics.some(
        (item) => item.code === "RUNTIME_NETWORK_POLICY_BLOCKED",
      ),
    );
    assert.equal(
      probe.dependencies.some(
        (item) =>
          item.specifier === "npm:lit@3.3.0" &&
          item.ok === false &&
          item.message === "Blocked by runtime network policy",
      ),
      true,
    );
  } finally {
    await runtime.terminate();
  }
});

test("runtime network policy supports wildcard hosts and default port normalization", () => {
  const runtime = new DefaultRuntimeManager({
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["*.jspm.io"],
  });

  const internals = runtime as unknown as {
    isRemoteUrlAllowed(url: string): boolean;
  };

  assert.equal(
    internals.isRemoteUrlAllowed(
      "https://ga.jspm.io:443/npm:lit@3.3.0/index.js",
    ),
    true,
  );
  assert.equal(
    internals.isRemoteUrlAllowed(
      "https://ga.jspm.io:80/npm:lit@3.3.0/index.js",
    ),
    false,
  );
  assert.equal(
    internals.isRemoteUrlAllowed(
      "http://ga.jspm.io:443/npm:lit@3.3.0/index.js",
    ),
    false,
  );
  assert.equal(
    internals.isRemoteUrlAllowed("https://jspm.io/npm:lit@3.3.0/index.js"),
    false,
  );
  assert.equal(
    internals.isRemoteUrlAllowed(
      "https://ga.jspm.io:444/npm:lit@3.3.0/index.js",
    ),
    false,
  );
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

test("runtime source loader preserves preact remote imports in browser runtime", async () => {
  class BrowserWorkerMock {}
  const restoreGlobals = installBrowserSandboxGlobals(BrowserWorkerMock);
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
  };

  const preactUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const resolved = await loader.materializeRemoteModule(preactUrl);
    assert.equal(resolved, preactUrl);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobals();
  }
});

test("runtime source loader preserves local preact node_modules imports in browser runtime", async () => {
  class BrowserWorkerMock {}
  const restoreGlobals = installBrowserSandboxGlobals(BrowserWorkerMock);
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
  };

  const preactUrl =
    "http://127.0.0.1:4317/node_modules/preact/hooks/dist/hooks.module.js";
  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const resolved = await loader.materializeRemoteModule(preactUrl);
    assert.equal(resolved, preactUrl);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobals();
  }
});

test("runtime source loader blocks preserved preact imports by runtime network policy", async () => {
  class BrowserWorkerMock {}
  const restoreGlobals = installBrowserSandboxGlobals(BrowserWorkerMock);
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["cdn.jspm.io"],
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
  };

  const preactUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      loader.materializeRemoteModule(preactUrl),
      /Remote module URL is blocked by runtime network policy/,
    );
    assert.equal(fetchCount, 0);
    assert.ok(
      diagnostics.some(
        (item) =>
          item.code === "RUNTIME_SOURCE_IMPORT_BLOCKED" &&
          item.message?.includes(preactUrl),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobals();
  }
});

test("runtime source loader materializes preact remote imports outside browser runtime", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
  };

  const preactUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const resolved = await loader.materializeRemoteModule(preactUrl);
    assert.notEqual(resolved, preactUrl);
    assert.match(resolved, /^data:text\/javascript;base64,/);
    assert.ok(fetchCount >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader strips sourcemap directives from materialized modules", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
  };

  const preactUrl =
    "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";
  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    return new Response(
      [
        "export const value = 1;",
        "//# sourceMappingURL=hooks.module.js.map",
      ].join("\n"),
      {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
        },
      },
    );
  }) as typeof fetch;

  try {
    const resolved = await loader.materializeRemoteModule(preactUrl);
    assert.match(resolved, /^data:text\/javascript;base64,/);
    const encoded = resolved.replace(/^data:text\/javascript;base64,/, "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.doesNotMatch(decoded, /sourceMappingURL/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader maps remote preact imports to local node file URLs", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      importSourceModuleFromCode(code: string): Promise<unknown>;
    };
  };

  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const namespace = (await loader.importSourceModuleFromCode(
      [
        'import { useState } from "https://ga.jspm.io/npm:preact@10.28.3/hooks/dist/hooks.module.js";',
        "export default function Counter() {",
        "  return typeof useState;",
        "}",
      ].join("\n"),
    )) as { default?: unknown };

    assert.equal(typeof namespace.default, "function");
    assert.equal((namespace.default as () => unknown)(), "function");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader maps esm.sh preact imports to local node file URLs", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      importSourceModuleFromCode(code: string): Promise<unknown>;
    };
  };

  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    fetchCount += 1;
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const namespace = (await loader.importSourceModuleFromCode(
      [
        'import { useState } from "https://esm.sh/preact@10.19.6/hooks";',
        "export default function Counter() {",
        "  return typeof useState;",
        "}",
      ].join("\n"),
    )) as { default?: unknown };

    assert.equal(typeof namespace.default, "function");
    assert.equal((namespace.default as () => unknown)(), "function");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime source loader falls back when preferred local preact entry is missing", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      resolveRuntimeImportSpecifier(
        specifier: string,
        parentUrl: string | undefined,
      ): Promise<string>;
      preactPackageRootPromise?: Promise<string | undefined>;
    };
  };

  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(undefined, diagnostics);
  loader.preactPackageRootPromise = Promise.resolve(
    "/tmp/renderify-missing-preact-root",
  );

  const resolved = await loader.resolveRuntimeImportSpecifier(
    "preact",
    undefined,
  );
  assert.match(resolved, /^file:\/\//);
  assert.equal(
    resolved.includes("renderify-missing-preact-root"),
    false,
    resolved,
  );
});

test("runtime source loader honors explicit manifest mappings before local preact shortcuts", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 500,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      resolveRuntimeImportSpecifier(
        specifier: string,
        parentUrl: string | undefined,
      ): Promise<string>;
    };
  };

  const diagnostics: Array<{ code?: string; message?: string }> = [];
  const loader = internals.createSourceModuleLoader(
    {
      react: {
        resolvedUrl:
          "https://ga.jspm.io/npm:preact@10.28.3/compat/dist/compat.module.js",
      },
    },
    diagnostics,
  );

  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response("export default function Compat() { return null; }", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const resolved = await loader.resolveRuntimeImportSpecifier(
      "react",
      undefined,
    );
    assert.match(resolved, /^data:text\/javascript;base64,/);
    assert.equal(
      requestedUrls.some((url) =>
        url.includes("/npm:preact@10.28.3/compat/dist/compat.module.js"),
      ),
      true,
    );
    assert.doesNotMatch(resolved, /^file:\/\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime evicts stale browser module URL cache entries beyond capacity", async () => {
  const runtime = new DefaultRuntimeManager({
    browserModuleUrlCacheMaxEntries: 2,
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 600,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
    browserModuleUrlCache: Map<string, string>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    return new Response(`export default ${JSON.stringify(String(input))};`, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const diagnostics: Array<{ code?: string; message?: string }> = [];
    const loader = internals.createSourceModuleLoader(undefined, diagnostics);
    await loader.materializeRemoteModule(
      "https://ga.jspm.io/npm:lit@3.3.0/index.js?cache=0",
    );
    await loader.materializeRemoteModule(
      "https://ga.jspm.io/npm:lit@3.3.0/index.js?cache=1",
    );
    await loader.materializeRemoteModule(
      "https://ga.jspm.io/npm:lit@3.3.0/index.js?cache=2",
    );

    assert.equal(internals.browserModuleUrlCache.size, 2);
    assert.equal(
      [...internals.browserModuleUrlCache.keys()].some((key) =>
        key.includes("cache=0"),
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime module caches are released across lifecycle cycles", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFallbackCdnBases: [],
    remoteFetchRetries: 0,
    remoteFetchBackoffMs: 10,
    remoteFetchTimeoutMs: 600,
  });

  const internals = runtime as unknown as {
    createSourceModuleLoader: (
      moduleManifest: RuntimeModuleManifest | undefined,
      diagnostics: Array<{ code?: string; message?: string }>,
    ) => {
      materializeRemoteModule(url: string): Promise<string>;
    };
    browserModuleUrlCache: Map<string, string>;
    browserModuleInflight: Map<string, Promise<string>>;
    browserBlobUrls: Set<string>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    return new Response("export default 'ok';", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await runtime.initialize();

      const diagnostics: Array<{ code?: string; message?: string }> = [];
      const loader = internals.createSourceModuleLoader(undefined, diagnostics);
      await loader.materializeRemoteModule(
        `https://ga.jspm.io/npm:lit@3.3.0/index.js?cycle=${cycle}`,
      );

      assert.ok(internals.browserModuleUrlCache.size > 0);
      await runtime.terminate();

      assert.equal(internals.browserModuleUrlCache.size, 0);
      assert.equal(internals.browserModuleInflight.size, 0);
      assert.equal(internals.browserBlobUrls.size, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.terminate();
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

test("runtime blocks execution when module integrity verification fails", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFetchTimeoutMs: 500,
    enableDependencyPreflight: false,
  });
  await runtime.initialize();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("export default 1;", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_integrity_mismatch_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("fallback")]),
      capabilities: {
        domWrite: true,
      },
      moduleManifest: {
        "npm:demo": {
          resolvedUrl: "https://ga.jspm.io/npm:demo@1/index.js",
          integrity: "sha384-invalid",
          signer: "tests",
        },
      },
    };

    const result = await runtime.executePlan(plan);
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "RUNTIME_INTEGRITY_MISMATCH",
      ),
    );
    assert.equal(result.root.type, "element");
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.terminate();
  }
});

test("runtime accepts module manifest entry when integrity verification succeeds", async () => {
  const runtime = new DefaultRuntimeManager({
    remoteFetchTimeoutMs: 500,
    enableDependencyPreflight: false,
  });
  await runtime.initialize();

  const moduleCode = "export default 1;";
  const integrity = `sha384-${createHash("sha384").update(moduleCode).digest("base64")}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(moduleCode, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }) as typeof fetch;

  try {
    const plan: RuntimePlan = {
      specVersion: DEFAULT_RUNTIME_PLAN_SPEC_VERSION,
      id: "runtime_integrity_ok_plan",
      version: 1,
      root: createElementNode("div", undefined, [createTextNode("ok")]),
      capabilities: {
        domWrite: true,
      },
      moduleManifest: {
        "npm:demo": {
          resolvedUrl: "https://ga.jspm.io/npm:demo@1/index.js",
          integrity,
          signer: "tests",
        },
      },
    };

    const result = await runtime.executePlan(plan);
    assert.equal(
      result.diagnostics.some(
        (item) =>
          item.code === "RUNTIME_INTEGRITY_MISMATCH" ||
          item.code === "RUNTIME_INTEGRITY_CHECK_FAILED",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.terminate();
  }
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
