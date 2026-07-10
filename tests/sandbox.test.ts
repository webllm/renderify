import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSourceInBrowserSandbox,
  type RuntimeSandboxRequest,
} from "../packages/runtime/src/sandbox";
import { wrapRuntimeSourceForSandbox } from "../packages/runtime/src/sandbox-hardening-source";

const BASE_REQUEST: RuntimeSandboxRequest = {
  renderifySandbox: "runtime-source",
  id: "sandbox_test",
  code: "export default () => ({ type: 'text', value: 'ok' });",
  exportName: "default",
  runtimeInput: {},
};

function cloneRequest(
  overrides: Partial<RuntimeSandboxRequest> = {},
): RuntimeSandboxRequest {
  return {
    ...BASE_REQUEST,
    ...overrides,
  };
}

test("sandbox hardening shadows dangerous runtime source globals", async () => {
  const source = wrapRuntimeSourceForSandbox(`
export default () => ({ globalThisType: typeof globalThis, fetchType: typeof fetch });
export function readBracketFetch() {
  return globalThis["fetch"];
}
`);
  const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  const namespace = (await import(moduleUrl)) as {
    default: () => Record<string, string>;
    readBracketFetch: () => unknown;
  };

  assert.deepEqual(namespace.default(), {
    globalThisType: "undefined",
    fetchType: "undefined",
  });
  assert.throws(() => namespace.readBracketFetch(), /undefined|globalThis/);
});

function installBlobUrlSupport(): () => void {
  const target = URL as unknown as Record<string, unknown>;
  const createDescriptor = Object.getOwnPropertyDescriptor(
    target,
    "createObjectURL",
  );
  const revokeDescriptor = Object.getOwnPropertyDescriptor(
    target,
    "revokeObjectURL",
  );

  Object.defineProperty(target, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:runtime-sandbox-test",
  });

  Object.defineProperty(target, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => {},
  });

  return () => {
    if (createDescriptor) {
      Object.defineProperty(target, "createObjectURL", createDescriptor);
    } else {
      delete target.createObjectURL;
    }

    if (revokeDescriptor) {
      Object.defineProperty(target, "revokeObjectURL", revokeDescriptor);
    } else {
      delete target.revokeObjectURL;
    }
  };
}

function installWorker(workerCtor: unknown): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "Worker");

  Object.defineProperty(root, "Worker", {
    configurable: true,
    writable: true,
    value: workerCtor,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(root, "Worker", descriptor);
    } else {
      delete root.Worker;
    }
  };
}

function clearWorker(): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "Worker");
  delete root.Worker;
  return () => {
    if (descriptor) {
      Object.defineProperty(root, "Worker", descriptor);
    }
  };
}

function installIframeEnvironment(output: unknown): () => void {
  const root = globalThis as Record<string, unknown>;
  const windowDescriptor = Object.getOwnPropertyDescriptor(root, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(root, "document");

  const contentWindow = {
    postMessage(
      payload: { channel?: string; type?: string },
      _targetOrigin?: string,
      transfer?: unknown[],
    ): void {
      const port = transfer?.[0] as
        | { postMessage: (value: unknown) => void }
        | undefined;
      if (!port || payload.type !== "init") {
        return;
      }

      queueMicrotask(() => {
        port.postMessage({ type: "ready" });
        port.postMessage({ type: "result", ok: true, output });
      });
    },
  };

  const iframeLoadHandlers = new Set<() => void>();

  const iframeElement = {
    style: {} as { display?: string },
    srcdoc: "",
    contentWindow,
    setAttribute(_name: string, _value: string): void {},
    addEventListener(type: string, handler: () => void): void {
      if (type === "load") {
        iframeLoadHandlers.add(handler);
      }
    },
    removeEventListener(type: string, handler: () => void): void {
      if (type === "load") {
        iframeLoadHandlers.delete(handler);
      }
    },
    remove(): void {},
  };

  const mockDocument = {
    body: {
      appendChild(_node: unknown): unknown {
        queueMicrotask(() => {
          for (const handler of iframeLoadHandlers) {
            handler();
          }
        });
        return iframeElement;
      },
    },
    createElement(tagName: string): unknown {
      if (tagName === "iframe") {
        return iframeElement;
      }
      throw new Error(`unexpected tag: ${tagName}`);
    },
  };

  const mockWindow = {} as Window;

  Object.defineProperty(root, "document", {
    configurable: true,
    writable: true,
    value: mockDocument,
  });
  Object.defineProperty(root, "window", {
    configurable: true,
    writable: true,
    value: mockWindow,
  });

  return () => {
    if (windowDescriptor) {
      Object.defineProperty(root, "window", windowDescriptor);
    } else {
      delete root.window;
    }

    if (documentDescriptor) {
      Object.defineProperty(root, "document", documentDescriptor);
    } else {
      delete root.document;
    }
  };
}

function clearIframeEnvironment(): () => void {
  const root = globalThis as Record<string, unknown>;
  const windowDescriptor = Object.getOwnPropertyDescriptor(root, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(root, "document");

  delete root.window;
  delete root.document;

  return () => {
    if (windowDescriptor) {
      Object.defineProperty(root, "window", windowDescriptor);
    }
    if (documentDescriptor) {
      Object.defineProperty(root, "document", documentDescriptor);
    }
  };
}

class SuccessWorker {
  private messageHandlers = new Set<(event: MessageEvent<unknown>) => void>();
  terminated = false;

  addEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.add(
        handler as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  removeEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.delete(
        handler as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  postMessage(payload: unknown): void {
    const request = payload as { id?: string };
    queueMicrotask(() => {
      for (const handler of this.messageHandlers) {
        handler({
          data: {
            renderifySandbox: "runtime-source",
            id: request.id,
            ok: true,
            output: { type: "text", value: "worker-ok" },
          },
        } as MessageEvent<unknown>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class TimeoutWorker {
  terminated = false;

  addEventListener(_type: string, _handler: EventListener): void {}

  removeEventListener(_type: string, _handler: EventListener): void {}

  postMessage(_payload: unknown): void {}

  terminate(): void {
    this.terminated = true;
  }
}

class DelayedWorker {
  static instances: DelayedWorker[] = [];

  private messageHandlers = new Set<(event: MessageEvent<unknown>) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  terminated = false;

  constructor() {
    DelayedWorker.instances.push(this);
  }

  static reset(): void {
    DelayedWorker.instances = [];
  }

  addEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.add(
        handler as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  removeEventListener(type: string, handler: EventListener): void {
    if (type === "message") {
      this.messageHandlers.delete(
        handler as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  postMessage(payload: unknown): void {
    const request = payload as { id?: string };
    this.timer = setTimeout(() => {
      if (this.terminated) {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler({
          data: {
            renderifySandbox: "runtime-source",
            id: request.id,
            ok: true,
            output: { type: "text", value: "delayed" },
          },
        } as MessageEvent<unknown>);
      }
    }, 200);
  }

  terminate(): void {
    this.terminated = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}

class InvalidShadowRealm {
  async importValue(
    _specifier: string,
    _bindingName: string,
  ): Promise<unknown> {
    return async () => "not-json";
  }
}

function installShadowRealm(shadowRealmCtor: unknown): () => void {
  const root = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(root, "ShadowRealm");

  Object.defineProperty(root, "ShadowRealm", {
    configurable: true,
    writable: true,
    value: shadowRealmCtor,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(root, "ShadowRealm", descriptor);
    } else {
      delete root.ShadowRealm;
    }
  };
}

test("sandbox rejects invalid request envelope", async () => {
  await assert.rejects(
    () =>
      executeSourceInBrowserSandbox({
        mode: "worker",
        timeoutMs: 50,
        request: cloneRequest({ id: "   " }),
      }),
    /Invalid runtime sandbox request envelope/,
  );
});

test("sandbox worker mode fails when a terminable worker is unavailable", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = clearWorker();
  const restoreIframe = clearIframeEnvironment();

  try {
    await assert.rejects(
      () =>
        executeSourceInBrowserSandbox({
          mode: "worker",
          timeoutMs: 20,
          request: cloneRequest(),
        }),
      /mode "worker" requires an available Worker/,
    );
  } finally {
    restoreIframe();
    restoreWorker();
    restoreBlob();
  }
});

test("sandbox iframe mode routes execution through a terminable worker", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = installWorker(SuccessWorker);
  const restoreIframe = installIframeEnvironment({
    type: "text",
    value: "must-not-use-iframe",
  });

  try {
    const result = await executeSourceInBrowserSandbox({
      mode: "iframe",
      timeoutMs: 100,
      request: cloneRequest(),
    });

    assert.equal(result.mode, "worker");
    assert.deepEqual(result.output, { type: "text", value: "worker-ok" });
  } finally {
    restoreIframe();
    restoreWorker();
    restoreBlob();
  }
});

test("sandbox worker and iframe modes fail closed without a worker", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = clearWorker();
  const restoreIframe = installIframeEnvironment({
    type: "text",
    value: "iframe-ok",
  });

  try {
    for (const mode of ["worker", "iframe"] as const) {
      await assert.rejects(
        () =>
          executeSourceInBrowserSandbox({
            mode,
            timeoutMs: 100,
            request: cloneRequest({
              code: "export default () => { while (true) {} }",
            }),
          }),
        new RegExp(`mode "${mode}" requires an available Worker`),
      );
    }
  } finally {
    restoreIframe();
    restoreWorker();
    restoreBlob();
  }
});

test("sandbox shadowrealm mode routes execution through a terminable worker", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = installWorker(SuccessWorker);
  const restoreShadowRealm = installShadowRealm(InvalidShadowRealm);
  const restoreIframe = clearIframeEnvironment();

  try {
    const result = await executeSourceInBrowserSandbox({
      mode: "shadowrealm",
      timeoutMs: 100,
      request: cloneRequest(),
    });

    assert.equal(result.mode, "worker");
    assert.deepEqual(result.output, { type: "text", value: "worker-ok" });
  } finally {
    restoreIframe();
    restoreShadowRealm();
    restoreWorker();
    restoreBlob();
  }
});

test("sandbox worker mode times out and terminates worker", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = installWorker(TimeoutWorker);

  try {
    await assert.rejects(
      () =>
        executeSourceInBrowserSandbox({
          mode: "worker",
          timeoutMs: 20,
          request: cloneRequest(),
        }),
      /Worker sandbox timed out/,
    );
  } finally {
    restoreWorker();
    restoreBlob();
  }
});

test("sandbox worker mode aborts with AbortError and terminates worker", async () => {
  DelayedWorker.reset();
  const restoreBlob = installBlobUrlSupport();
  const restoreWorker = installWorker(DelayedWorker);

  const controller = new AbortController();

  try {
    const pending = executeSourceInBrowserSandbox({
      mode: "worker",
      timeoutMs: 1000,
      signal: controller.signal,
      request: cloneRequest(),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    assert.ok(
      DelayedWorker.instances.length > 0,
      "expected at least one worker instance",
    );
    assert.ok(
      DelayedWorker.instances.every((worker) => worker.terminated),
      "expected worker termination on abort",
    );
  } finally {
    restoreWorker();
    restoreBlob();
    DelayedWorker.reset();
  }
});

test("sandbox shadowrealm mode does not execute in an available ShadowRealm", async () => {
  const restoreBlob = installBlobUrlSupport();
  const restoreShadowRealm = installShadowRealm(InvalidShadowRealm);
  const restoreWorker = clearWorker();
  const restoreIframe = clearIframeEnvironment();

  try {
    await assert.rejects(
      () =>
        executeSourceInBrowserSandbox({
          mode: "shadowrealm",
          timeoutMs: 100,
          request: cloneRequest(),
        }),
      /mode "shadowrealm" requires an available Worker/,
    );
  } finally {
    restoreIframe();
    restoreWorker();
    restoreShadowRealm();
    restoreBlob();
  }
});
