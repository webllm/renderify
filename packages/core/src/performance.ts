export interface PerformanceMetric {
  label: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface PerformanceOptimizer {
  startMeasurement(label: string): void;
  endMeasurement(label: string): PerformanceMetric | undefined;
  getMetrics(): PerformanceMetric[];
  reset(): void;
}

interface TimerState {
  label: string;
  startedAt: number;
}

export class DefaultPerformanceOptimizer implements PerformanceOptimizer {
  private readonly timers: Map<string, TimerState> = new Map();
  private readonly metrics: PerformanceMetric[] = [];

  startMeasurement(label: string): void {
    this.timers.set(label, {
      label,
      startedAt: nowMs(),
    });
  }

  endMeasurement(label: string): PerformanceMetric | undefined {
    const timer = this.timers.get(label);
    if (!timer) {
      return undefined;
    }

    const endedAt = nowMs();
    const metric: PerformanceMetric = {
      label,
      startedAt: timer.startedAt,
      endedAt,
      durationMs: endedAt - timer.startedAt,
    };

    this.metrics.push(metric);
    this.timers.delete(label);
    return metric;
  }

  getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  reset(): void {
    this.timers.clear();
    this.metrics.length = 0;
  }
}

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}
