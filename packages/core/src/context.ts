export interface RenderifyContext {
  user?: {
    id: string;
    name?: string;
    role?: string;
  };
  app?: {
    version: string;
    environment?: "development" | "staging" | "production";
  };
  [key: string]: unknown;
}

export interface ContextManager {
  initialize(): Promise<void>;
  getContext(): RenderifyContext;
  updateContext(partialCtx: Partial<RenderifyContext>): void;
  subscribe(listener: (ctx: RenderifyContext) => void): () => void;
}

export class DefaultContextManager implements ContextManager {
  private ctx: RenderifyContext = {};
  private listeners = new Set<(ctx: RenderifyContext) => void>();

  async initialize(): Promise<void> {
    this.ctx = {
      user: { id: "anonymous" },
      app: { version: "0.1.0", environment: "development" },
    };
  }

  getContext(): RenderifyContext {
    return cloneContext(this.ctx);
  }

  updateContext(partialCtx: Partial<RenderifyContext>): void {
    const partial = cloneContext(partialCtx as RenderifyContext);
    const nextUser =
      partial.user || this.ctx.user
        ? {
            id: partial.user?.id ?? this.ctx.user?.id ?? "anonymous",
            name: partial.user?.name ?? this.ctx.user?.name,
            role: partial.user?.role ?? this.ctx.user?.role,
          }
        : undefined;

    const nextApp =
      partial.app || this.ctx.app
        ? {
            version: partial.app?.version ?? this.ctx.app?.version ?? "0.1.0",
            environment: partial.app?.environment ?? this.ctx.app?.environment,
          }
        : undefined;

    this.ctx = {
      ...this.ctx,
      ...partial,
      user: nextUser,
      app: nextApp,
    };

    this.notify();
  }

  subscribe(listener: (ctx: RenderifyContext) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb(this.getContext());
    }
  }
}

function cloneContext(context: RenderifyContext): RenderifyContext {
  return cloneContextValue(context, new WeakMap<object, unknown>());
}

function cloneContextValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) {
      clone.push(cloneContextValue(entry, seen));
    }
    return clone as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneContextValue(entry, seen);
  }
  return clone as T;
}
