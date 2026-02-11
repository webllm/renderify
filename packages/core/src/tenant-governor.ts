export interface TenantQuotaPolicy {
  maxExecutionsPerMinute: number;
  maxConcurrentExecutions: number;
}

export interface TenantQuotaSnapshot {
  tenantId: string;
  windowStartedAt: number;
  executionsInWindow: number;
  concurrentExecutions: number;
}

export interface TenantLease {
  release(): void;
}

export interface TenantGovernor {
  initialize(policyOverrides?: Partial<TenantQuotaPolicy>): void;
  getPolicy(): TenantQuotaPolicy;
  acquire(tenantId: string): TenantLease;
  listSnapshots(): TenantQuotaSnapshot[];
  reset(): void;
}

export class TenantQuotaExceededError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string, message: string) {
    super(message);
    this.name = "TenantQuotaExceededError";
    this.tenantId = tenantId;
  }
}

interface TenantWindowState {
  windowStartedAt: number;
  executionsInWindow: number;
  concurrentExecutions: number;
}

const DEFAULT_POLICY: TenantQuotaPolicy = {
  maxExecutionsPerMinute: 120,
  maxConcurrentExecutions: 4,
};

const WINDOW_MS = 60_000;

export class InMemoryTenantGovernor implements TenantGovernor {
  private policy: TenantQuotaPolicy = { ...DEFAULT_POLICY };
  private readonly states = new Map<string, TenantWindowState>();

  initialize(policyOverrides?: Partial<TenantQuotaPolicy>): void {
    this.policy = {
      ...DEFAULT_POLICY,
      ...policyOverrides,
    };
  }

  getPolicy(): TenantQuotaPolicy {
    return { ...this.policy };
  }

  acquire(tenantId: string): TenantLease {
    const normalizedTenantId =
      typeof tenantId === "string" && tenantId.trim().length > 0
        ? tenantId.trim()
        : "anonymous";
    const now = Date.now();
    const state = this.resolveState(normalizedTenantId, now);

    if (state.concurrentExecutions >= this.policy.maxConcurrentExecutions) {
      throw new TenantQuotaExceededError(
        normalizedTenantId,
        `Tenant ${normalizedTenantId} exceeded max concurrent executions (${this.policy.maxConcurrentExecutions})`
      );
    }

    if (state.executionsInWindow >= this.policy.maxExecutionsPerMinute) {
      throw new TenantQuotaExceededError(
        normalizedTenantId,
        `Tenant ${normalizedTenantId} exceeded max executions per minute (${this.policy.maxExecutionsPerMinute})`
      );
    }

    state.executionsInWindow += 1;
    state.concurrentExecutions += 1;

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        const currentState = this.states.get(normalizedTenantId);
        if (!currentState) {
          return;
        }

        currentState.concurrentExecutions = Math.max(
          0,
          currentState.concurrentExecutions - 1
        );
      },
    };
  }

  listSnapshots(): TenantQuotaSnapshot[] {
    const snapshots: TenantQuotaSnapshot[] = [];

    for (const [tenantId, state] of this.states.entries()) {
      snapshots.push({
        tenantId,
        windowStartedAt: state.windowStartedAt,
        executionsInWindow: state.executionsInWindow,
        concurrentExecutions: state.concurrentExecutions,
      });
    }

    return snapshots.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  reset(): void {
    this.states.clear();
  }

  private resolveState(tenantId: string, now: number): TenantWindowState {
    const current =
      this.states.get(tenantId) ??
      {
        windowStartedAt: now,
        executionsInWindow: 0,
        concurrentExecutions: 0,
      };

    if (now - current.windowStartedAt >= WINDOW_MS) {
      current.windowStartedAt = now;
      current.executionsInWindow = 0;
    }

    this.states.set(tenantId, current);
    return current;
  }
}
