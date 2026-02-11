import type { RuntimeEvent } from "@renderify/ir";

export type ExecutionMode =
  | "prompt"
  | "plan"
  | "rollback"
  | "replay"
  | "event";

export type ExecutionStatus =
  | "succeeded"
  | "rejected"
  | "throttled"
  | "failed";

export interface ExecutionAuditRecord {
  traceId: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  prompt?: string;
  tenantId?: string;
  planId?: string;
  planVersion?: number;
  diagnosticsCount: number;
  securityIssueCount: number;
  event?: RuntimeEvent;
  errorMessage?: string;
}

export interface ExecutionAuditLog {
  append(record: ExecutionAuditRecord): void;
  get(traceId: string): ExecutionAuditRecord | undefined;
  list(limit?: number): ExecutionAuditRecord[];
  clear(): void;
}

export class InMemoryExecutionAuditLog implements ExecutionAuditLog {
  private readonly records: ExecutionAuditRecord[] = [];

  append(record: ExecutionAuditRecord): void {
    this.records.push({ ...record });
  }

  get(traceId: string): ExecutionAuditRecord | undefined {
    const found = this.records.find((record) => record.traceId === traceId);
    return found ? { ...found } : undefined;
  }

  list(limit?: number): ExecutionAuditRecord[] {
    const ordered = [...this.records].sort((a, b) => b.startedAt - a.startedAt);

    if (typeof limit === "number" && limit > 0) {
      return ordered.slice(0, limit).map((record) => ({ ...record }));
    }

    return ordered.map((record) => ({ ...record }));
  }

  clear(): void {
    this.records.length = 0;
  }
}
