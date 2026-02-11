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

  async initialize() {
    this.ctx = {
      user: { id: "anonymous" },
      app: { version: "0.1.0", environment: "development" },
    };
  }

  getContext(): RenderifyContext {
    return this.ctx;
  }

  updateContext(partialCtx: Partial<RenderifyContext>) {
    const nextUser =
      partialCtx.user || this.ctx.user
        ? {
            id: partialCtx.user?.id ?? this.ctx.user?.id ?? "anonymous",
            name: partialCtx.user?.name ?? this.ctx.user?.name,
            role: partialCtx.user?.role ?? this.ctx.user?.role,
          }
        : undefined;

    const nextApp =
      partialCtx.app || this.ctx.app
        ? {
            version: partialCtx.app?.version ?? this.ctx.app?.version ?? "0.1.0",
            environment:
              partialCtx.app?.environment ?? this.ctx.app?.environment,
          }
        : undefined;

    this.ctx = {
      ...this.ctx,
      ...partialCtx,
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

  private notify() {
    for (const cb of this.listeners) {
      cb(this.ctx);
    }
  }
}
