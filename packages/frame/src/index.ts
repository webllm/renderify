import { createRenderifyFrameDocument } from "./document";
import { DEFAULT_LOOP_TIMEOUT_MS } from "./loop-guard";
import {
  RENDERIFY_FRAME_CONNECT,
  RENDERIFY_FRAME_PROTOCOL,
  type RenderifyFrameAction,
  type RenderifyFrameInput,
  type RenderifyFrameResult,
  type RenderifyFrameTheme,
  readFrameTheme,
  readFrameToHostMessage,
} from "./protocol";

export {
  createRenderifyFrameDocument,
  DEFAULT_RENDERIFY_FRAME_MODULE_ORIGINS,
  type RenderifyFrameDocument,
  type RenderifyFrameDocumentOptions,
} from "./document";
export {
  createLoopGuardPlugin,
  DEFAULT_LOOP_TIMEOUT_MS,
  guardSourceLoops,
  type RenderifyLoopGuardLanguage,
} from "./loop-guard";
export {
  RENDERIFY_FRAME_PROTOCOL,
  type RenderifyFrameAction,
  type RenderifyFrameDiagnostic,
  type RenderifyFrameInput,
  type RenderifyFrameResult,
  type RenderifyFrameSourceLanguage,
  type RenderifyFrameTheme,
} from "./protocol";

declare const __RENDERIFY_FRAME_VERSION__: string;
declare const __RENDERIFY_FRAME_RUNNER_INTEGRITY__: string;
declare const __RENDERIFY_FRAME_PLAN_RUNNER_INTEGRITY__: string;

export const RENDERIFY_FRAME_VERSION =
  typeof __RENDERIFY_FRAME_VERSION__ === "string"
    ? __RENDERIFY_FRAME_VERSION__
    : "0.0.0";

/**
 * The runner published with this package version, loaded with Subresource
 * Integrity. Self-host `@renderify/frame/runner.js` and pass `runnerUrl` to
 * avoid the third-party CDN.
 */
export const DEFAULT_RENDERIFY_FRAME_RUNNER_URL = `https://cdn.jsdelivr.net/npm/@renderify/frame@${RENDERIFY_FRAME_VERSION}/dist/runner.js`;

/**
 * The declarative-only runner: renders RuntimePlans without bundling Babel,
 * so the frame downloads and boots much faster. Select it with
 * `runner: "plan"`.
 */
export const DEFAULT_RENDERIFY_FRAME_PLAN_RUNNER_URL = `https://cdn.jsdelivr.net/npm/@renderify/frame@${RENDERIFY_FRAME_VERSION}/dist/runner-plan.js`;

const DEFAULT_RUNNER_INTEGRITY =
  typeof __RENDERIFY_FRAME_RUNNER_INTEGRITY__ === "string"
    ? __RENDERIFY_FRAME_RUNNER_INTEGRITY__
    : undefined;
const DEFAULT_PLAN_RUNNER_INTEGRITY =
  typeof __RENDERIFY_FRAME_PLAN_RUNNER_INTEGRITY__ === "string"
    ? __RENDERIFY_FRAME_PLAN_RUNNER_INTEGRITY__
    : undefined;

export type RenderifyFrameStatus =
  | "booting"
  | "ready"
  | "rendering"
  | "rendered"
  | "failed"
  | "timed-out"
  | "disposed";

export type RenderifyFrameErrorCode =
  | "boot-failed"
  | "timeout"
  | "superseded"
  | "reset"
  | "disposed"
  | "render-failed"
  | "invalid-input";

export class RenderifyFrameError extends Error {
  readonly code: RenderifyFrameErrorCode;
  readonly durationMs?: number;

  constructor(
    code: RenderifyFrameErrorCode,
    message: string,
    durationMs?: number,
  ) {
    super(message);
    this.name = "RenderifyFrameError";
    this.code = code;
    if (durationMs !== undefined) {
      this.durationMs = durationMs;
    }
  }
}

export interface RenderifyFrameOptions {
  /** Element the iframe is appended to. */
  container: HTMLElement;
  /**
   * `full` (default) renders source and plans; `plan` loads the smaller
   * declarative-only runner, which rejects source.
   */
  runner?: "full" | "plan";
  /** Runner script URL; defaults to this version on jsDelivr. */
  runnerUrl?: string;
  /**
   * The runner's code to inline instead of loading `runnerUrl`, for frames
   * that must not fetch scripts (for example inside an MCP App view).
   */
  runnerSource?: string;
  /** SRI hash for a custom `runnerUrl`; the default URL is always pinned. */
  runnerIntegrity?: string;
  /** Origins rendered code may import npm modules from. */
  moduleOrigins?: readonly string[];
  /** Watchdog for one render, after which the frame is reset. @defaultValue 45000 */
  timeoutMs?: number;
  /** How long the runner may take to connect. @defaultValue 20000 */
  bootTimeoutMs?: number;
  /** Synchronous loops running longer than this throw; 0 disables. @defaultValue 1500 */
  loopTimeoutMs?: number;
  /** Largest accepted source or JSON plan, in UTF-8 bytes. @defaultValue 262144 */
  maxInputBytes?: number;
  /** Size the iframe to its content. @defaultValue true */
  autoResize?: boolean | { minHeight?: number; maxHeight?: number };
  /** CSS custom properties and color scheme applied inside the frame. */
  theme?: RenderifyFrameTheme;
  /** Action types `onAction` may receive; everything else is blocked. */
  allowedActions?: readonly string[];
  onAction?(action: RenderifyFrameAction): void;
  onBlockedAction?(action: RenderifyFrameAction): void;
  /** Errors thrown by rendered content after it rendered, e.g. in a click handler. */
  onRuntimeError?(message: string): void;
  onStatusChange?(status: RenderifyFrameStatus): void;
  /** Accessible title for the iframe. */
  title?: string;
}

export interface RenderifyFrame {
  /** The current iframe; a new one replaces it after `reset()`. */
  readonly element: HTMLIFrameElement;
  readonly status: RenderifyFrameStatus;
  /** Resolves once the runner has connected. */
  ready(): Promise<void>;
  /**
   * Renders into the frame. A newer render supersedes an unfinished one,
   * which rejects with code `superseded`.
   */
  render(input: RenderifyFrameInput): Promise<RenderifyFrameResult>;
  setTheme(theme: RenderifyFrameTheme): void;
  /** Destroys the iframe, including any runaway code, and boots a new one. */
  reset(): Promise<void>;
  dispose(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingRender {
  id: number;
  deferred: Deferred<RenderifyFrameResult>;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;

/**
 * Creates an opaque-origin sandboxed iframe (`sandbox="allow-scripts"`) that
 * renders model-generated source and RuntimePlans. Rendered code cannot read
 * the host page, its cookies, or storage; it reaches the host only through
 * validated messages on a private MessagePort, and only allowlisted actions
 * are delivered.
 */
export function createRenderifyFrame(
  options: RenderifyFrameOptions,
): RenderifyFrame {
  if (typeof document === "undefined") {
    throw new Error("createRenderifyFrame requires a browser document");
  }
  const container = options.container;
  const planOnly = options.runner === "plan";
  const frameDocument =
    options.runnerSource !== undefined
      ? createRenderifyFrameDocument({
          runnerSource: options.runnerSource,
          moduleOrigins: options.moduleOrigins,
        })
      : createRenderifyFrameDocument({
          runnerUrl: new URL(
            options.runnerUrl ??
              (planOnly
                ? DEFAULT_RENDERIFY_FRAME_PLAN_RUNNER_URL
                : DEFAULT_RENDERIFY_FRAME_RUNNER_URL),
            document.baseURI,
          ).href,
          runnerIntegrity:
            options.runnerUrl === undefined
              ? planOnly
                ? DEFAULT_PLAN_RUNNER_INTEGRITY
                : DEFAULT_RUNNER_INTEGRITY
              : options.runnerIntegrity,
          moduleOrigins: options.moduleOrigins,
        });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const loopTimeoutMs = options.loopTimeoutMs ?? DEFAULT_LOOP_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const allowedActions = new Set(options.allowedActions ?? []);
  const resize =
    options.autoResize === false
      ? undefined
      : {
          minHeight:
            typeof options.autoResize === "object"
              ? (options.autoResize.minHeight ?? 0)
              : 0,
          maxHeight:
            typeof options.autoResize === "object"
              ? (options.autoResize.maxHeight ?? Number.POSITIVE_INFINITY)
              : Number.POSITIVE_INFINITY,
        };

  let theme = options.theme ? readFrameTheme(options.theme) : undefined;
  if (options.theme && !theme) {
    throw new RenderifyFrameError("invalid-input", "Invalid frame theme");
  }
  let iframe!: HTMLIFrameElement;
  let port: MessagePort | undefined;
  let generation = 0;
  let status: RenderifyFrameStatus = "booting";
  let disposed = false;
  let boot!: Deferred<void>;
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let pending: PendingRender | undefined;

  const setStatus = (next: RenderifyFrameStatus) => {
    if (status !== next) {
      status = next;
      options.onStatusChange?.(next);
    }
  };

  const postTheme = () => {
    if (theme && port) {
      port.postMessage({ type: "theme", theme });
    }
  };

  const settle = (
    entry: PendingRender,
    outcome: { result: RenderifyFrameResult } | { error: unknown },
  ) => {
    if (pending !== entry) {
      return;
    }
    pending = undefined;
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    if ("result" in outcome) {
      entry.deferred.resolve(outcome.result);
    } else {
      entry.deferred.reject(outcome.error);
    }
  };

  const teardown = (reason: RenderifyFrameError) => {
    generation += 1;
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = undefined;
    }
    port?.close();
    port = undefined;
    iframe?.remove();
    boot?.reject(reason);
    if (pending) {
      settle(pending, { error: reason });
    }
  };

  const start = () => {
    const current = ++generation;
    boot = createDeferred<void>();
    setStatus("booting");

    iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.title = options.title ?? "Renderify sandboxed preview";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.width = "100%";
    if (resize) {
      iframe.style.height = `${resize.minHeight}px`;
    }
    iframe.srcdoc = frameDocument.html;
    iframe.addEventListener("load", () => connect(current), { once: true });
    bootTimer = setTimeout(() => {
      if (current === generation && status === "booting") {
        failBoot(current, "The sandboxed runner did not start in time");
      }
    }, bootTimeoutMs);
    container.append(iframe);
  };

  const failBoot = (current: number, message: string) => {
    if (current !== generation) {
      return;
    }
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = undefined;
    }
    const error = new RenderifyFrameError("boot-failed", message);
    boot.reject(error);
    if (pending) {
      settle(pending, { error });
    }
    setStatus("failed");
  };

  const connect = (current: number) => {
    const target = iframe.contentWindow;
    if (current !== generation || disposed || !target) {
      return;
    }
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event: MessageEvent<unknown>) =>
      handleMessage(current, event.data);
    port.start();
    target.postMessage(
      { type: RENDERIFY_FRAME_CONNECT, protocol: RENDERIFY_FRAME_PROTOCOL },
      "*",
      [channel.port2],
    );
  };

  const handleMessage = (current: number, data: unknown) => {
    if (current !== generation) {
      return;
    }
    const message = readFrameToHostMessage(data);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "ready": {
        if (status !== "booting") {
          return;
        }
        if (message.protocol !== RENDERIFY_FRAME_PROTOCOL) {
          failBoot(current, `Unsupported runner protocol ${message.protocol}`);
          return;
        }
        if (bootTimer) {
          clearTimeout(bootTimer);
          bootTimer = undefined;
        }
        postTheme();
        setStatus("ready");
        boot.resolve();
        return;
      }
      case "rendered":
        if (pending?.id === message.id) {
          settle(pending, { result: message.result });
          setStatus("rendered");
        }
        return;
      case "failed":
        if (pending?.id === message.id) {
          settle(pending, {
            error: new RenderifyFrameError(
              "render-failed",
              message.message,
              message.durationMs,
            ),
          });
          setStatus("failed");
        }
        return;
      case "resize":
        if (resize) {
          const height = Math.min(
            resize.maxHeight,
            Math.max(resize.minHeight, message.height),
          );
          iframe.style.height = `${height}px`;
        }
        return;
      case "action":
        if (allowedActions.has(message.action.type)) {
          options.onAction?.(message.action);
        } else {
          options.onBlockedAction?.(message.action);
        }
        return;
      case "runtime-error":
        options.onRuntimeError?.(message.message);
        return;
    }
  };

  start();

  const frame: RenderifyFrame = {
    get element() {
      return iframe;
    },
    get status() {
      return status;
    },
    ready: () => boot.promise,
    render(input) {
      if (disposed) {
        return Promise.reject(
          new RenderifyFrameError("disposed", "The frame was disposed"),
        );
      }
      let message: unknown;
      try {
        message = { ...toTransferableInput(input, maxInputBytes) };
      } catch (error) {
        return Promise.reject(error);
      }
      if (pending) {
        settle(pending, {
          error: new RenderifyFrameError(
            "superseded",
            "A newer render replaced this one",
          ),
        });
      }
      const entry: PendingRender = {
        id: ++sequence,
        deferred: createDeferred<RenderifyFrameResult>(),
      };
      pending = entry;

      boot.promise.then(
        () => {
          if (pending !== entry || !port) {
            return;
          }
          port.postMessage({
            type: "render",
            id: entry.id,
            input: message,
            loopTimeoutMs,
          });
          setStatus("rendering");
          entry.timer = setTimeout(() => {
            if (pending !== entry) {
              return;
            }
            settle(entry, {
              error: new RenderifyFrameError(
                "timeout",
                `Render did not finish within ${timeoutMs} ms; the frame was reset`,
              ),
            });
            setStatus("timed-out");
            void frame.reset().catch(() => {});
          }, timeoutMs);
        },
        (error: unknown) => settle(entry, { error }),
      );
      return entry.deferred.promise;
    },
    setTheme(next) {
      const validated = readFrameTheme(next);
      if (!validated) {
        throw new RenderifyFrameError("invalid-input", "Invalid frame theme");
      }
      theme = validated;
      postTheme();
    },
    async reset() {
      if (disposed) {
        throw new RenderifyFrameError("disposed", "The frame was disposed");
      }
      teardown(new RenderifyFrameError("reset", "The frame was reset"));
      start();
      await boot.promise;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      teardown(new RenderifyFrameError("disposed", "The frame was disposed"));
      setStatus("disposed");
    },
  };
  return frame;
}

/** Creates a frame, renders one source module into it, and returns both. */
export async function renderSandboxedSource(
  container: HTMLElement,
  source: string,
  options: Omit<RenderifyFrameOptions, "container"> & {
    language?: "js" | "jsx" | "ts" | "tsx";
    runtime?: "preact" | "renderify";
  } = {},
): Promise<{ frame: RenderifyFrame; result: RenderifyFrameResult }> {
  const { language, runtime, ...frameOptions } = options;
  const frame = createRenderifyFrame({ ...frameOptions, container });
  try {
    const result = await frame.render({
      source,
      ...(language ? { language } : {}),
      ...(runtime ? { runtime } : {}),
    });
    return { frame, result };
  } catch (error) {
    frame.dispose();
    throw error;
  }
}

function toTransferableInput(
  input: RenderifyFrameInput,
  maxInputBytes: number,
): RenderifyFrameInput {
  if (typeof input !== "object" || input === null) {
    throw new RenderifyFrameError(
      "invalid-input",
      "Expected { source } or { plan }",
    );
  }
  if ("source" in input) {
    if (typeof input.source !== "string") {
      throw new RenderifyFrameError("invalid-input", "source must be a string");
    }
    assertSize(input.source, maxInputBytes, "Source");
    return input;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input.plan);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new RenderifyFrameError("invalid-input", "plan must be JSON");
  }
  assertSize(serialized, maxInputBytes, "Plan");
  return { plan: JSON.parse(serialized) as unknown };
}

function assertSize(text: string, maxBytes: number, label: string): void {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    throw new RenderifyFrameError(
      "invalid-input",
      `${label} is ${bytes} bytes; the limit is ${maxBytes} bytes`,
    );
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Callers may never await ready(); avoid unhandled rejection noise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
