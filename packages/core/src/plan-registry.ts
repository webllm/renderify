import type { RuntimePlan } from "@renderify/ir";

export interface PlanVersionRecord {
  planId: string;
  version: number;
  plan: RuntimePlan;
  registeredAt: number;
}

export interface PlanSummary {
  planId: string;
  latestVersion: number;
  versions: number[];
}

export interface PlanRegistry {
  register(plan: RuntimePlan): PlanVersionRecord;
  get(planId: string, version?: number): PlanVersionRecord | undefined;
  list(): PlanSummary[];
  listVersions(planId: string): PlanVersionRecord[];
  remove(planId: string): void;
  clear(): void;
}

export class InMemoryPlanRegistry implements PlanRegistry {
  private readonly records = new Map<string, Map<number, PlanVersionRecord>>();

  register(plan: RuntimePlan): PlanVersionRecord {
    let normalizedPlan = normalizePlan(plan);
    const planId = normalizedPlan.id;
    let version = normalizedPlan.version;

    const versionMap = this.records.get(planId) ?? new Map<number, PlanVersionRecord>();

    if (versionMap.has(version)) {
      const latestVersion =
        versionMap.size === 0 ? 0 : Math.max(...versionMap.keys());
      version = latestVersion + 1;
      normalizedPlan = {
        ...normalizedPlan,
        version,
      };
    }

    const record: PlanVersionRecord = {
      planId,
      version,
      plan: clonePlan(normalizedPlan),
      registeredAt: Date.now(),
    };

    versionMap.set(version, record);
    this.records.set(planId, versionMap);

    return cloneRecord(record);
  }

  get(planId: string, version?: number): PlanVersionRecord | undefined {
    const versionMap = this.records.get(planId);
    if (!versionMap || versionMap.size === 0) {
      return undefined;
    }

    const resolvedVersion =
      version === undefined ? Math.max(...versionMap.keys()) : version;

    const record = versionMap.get(resolvedVersion);
    if (!record) {
      return undefined;
    }

    return cloneRecord(record);
  }

  list(): PlanSummary[] {
    const summaries: PlanSummary[] = [];

    for (const [planId, versionMap] of this.records.entries()) {
      const versions = [...versionMap.keys()].sort((a, b) => a - b);
      if (versions.length === 0) {
        continue;
      }

      summaries.push({
        planId,
        latestVersion: versions[versions.length - 1],
        versions,
      });
    }

    return summaries.sort((a, b) => a.planId.localeCompare(b.planId));
  }

  listVersions(planId: string): PlanVersionRecord[] {
    const versionMap = this.records.get(planId);
    if (!versionMap) {
      return [];
    }

    return [...versionMap.values()]
      .sort((a, b) => a.version - b.version)
      .map(cloneRecord);
  }

  remove(planId: string): void {
    this.records.delete(planId);
  }

  clear(): void {
    this.records.clear();
  }
}

function normalizePlan(input: RuntimePlan): RuntimePlan {
  const fallbackId = `plan_${Date.now().toString(36)}`;

  const id =
    typeof input.id === "string" && input.id.trim().length > 0
      ? input.id.trim()
      : fallbackId;

  const version =
    Number.isInteger(input.version) && input.version > 0 ? input.version : 1;

  return {
    ...input,
    id,
    version,
  };
}

function clonePlan(plan: RuntimePlan): RuntimePlan {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(plan);
  }

  return JSON.parse(JSON.stringify(plan)) as RuntimePlan;
}

function cloneRecord(record: PlanVersionRecord): PlanVersionRecord {
  return {
    ...record,
    plan: clonePlan(record.plan),
  };
}
