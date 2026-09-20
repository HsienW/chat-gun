import { getAgentRuntimeConfig } from "../runtime-config.js";
import type { ExecutionContext } from "../../runtime/execution-context/execution-context.js";

type MetricCorrelation = Pick<ExecutionContext, "requestId" | "threadId" | "runId" | "taskId">;

export type TaskMetric = {
  correlation?: MetricCorrelation;
  kind: "task";
  taskId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  durationMs?: number;
  stepCount?: number;
  ts: number;
};

export type StepMetric = {
  correlation?: MetricCorrelation;
  kind: "step";
  stepId: string;
  taskId: string;
  nodeName: string;
  status: "running" | "completed" | "failed" | "retrying";
  durationMs?: number;
  attempt?: number;
  ts: number;
};

export type ToolMetric = {
  correlation?: MetricCorrelation;
  kind: "tool";
  toolName: string;
  taskId: string;
  stepId: string;
  status: "success" | "error" | "timeout" | "permission_denied";
  durationMs: number;
  toolCallId?: string;
  ts: number;
};

export type TokenMetric = {
  kind: "token";
  taskId: string;
  stepId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  ts: number;
};

export type CostMetric = {
  kind: "cost";
  taskId: string;
  totalCost: number;
  currency: string;
  breakdown: {
    modelCost: number;
    toolCost: number;
  };
  ts: number;
};

export type EventMetric = {
  kind: "event";
  name: string;
  value: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
  ts: number;
};

export type MetricEntry =
  | TaskMetric
  | StepMetric
  | ToolMetric
  | TokenMetric
  | CostMetric
  | EventMetric;

export type MetricsSnapshot = {
  snapshotTs: number;
  metrics: {
    tasks: {
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      running: number;
    };
    steps: {
      total: number;
      completed: number;
      failed: number;
      retrying: number;
    };
    tools: {
      total: number;
      success: number;
      error: number;
      timeout: number;
      permissionDenied: number;
    };
    tokens: {
      totalInput: number;
      totalOutput: number;
      totalTokens: number;
      avgTokensPerTask: number;
    };
    cost: {
      totalCost: number;
      currency: string;
      modelCost: number;
      toolCost: number;
    };
    latency: {
      avgTaskDurationMs: number;
      p95TaskDurationMs?: number;
    };
    rates: {
      taskSuccessRate: number;
      toolSuccessRate: number;
      retryRecoveryRate: number;
      modelFallbackRate?: number;
      structuredOutputRepairSuccessRate?: number;
    };
  };
};

export interface MetricRecorder {
  record(entry: MetricEntry): void;
}

export interface MetricsCollector extends MetricRecorder {
  entries(): readonly MetricEntry[];
  snapshot(): MetricsSnapshot;
  reset(): void;
}

export type MetricsCollectorOptions = {
  maxEntries?: number;
  isEnabled?: boolean;
};

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CURRENCY = "USD";

function countStatus<T extends { status: string }>(entries: readonly T[], status: string): number {
  return entries.filter((entry) => entry.status === status).length;
}

function successRate(successCount: number, totalCount: number): number {
  return totalCount === 0 ? 1 : successCount / totalCount;
}

function percentile95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sortedValues = [...values].sort((left, right) => left - right);
  return sortedValues[Math.ceil(sortedValues.length * 0.95) - 1];
}

function eventCount(entries: readonly EventMetric[], name: string): number {
  return entries
    .filter((entry) => entry.name === name)
    .reduce((total, entry) => total + entry.value, 0);
}

function eventCallIds(entries: readonly EventMetric[], name: string): Set<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.name === name && typeof entry.attributes.callId === "string"
        ? [entry.attributes.callId]
        : []
    )
  );
}

class InMemoryMetricsCollector implements MetricsCollector {
  private readonly buffer: Array<MetricEntry | undefined> = [];
  private readonly maxEntries: number;
  private readonly isEnabled: boolean;
  private size = 0;
  private nextIndex = 0;

  constructor(options: MetricsCollectorOptions) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.isEnabled = options.isEnabled ?? true;
  }

  record(entry: MetricEntry): void {
    if (!this.isEnabled) return;

    this.buffer[this.nextIndex] = entry;
    this.nextIndex = (this.nextIndex + 1) % this.maxEntries;
    this.size = Math.min(this.size + 1, this.maxEntries);
  }

  entries(): readonly MetricEntry[] {
    if (this.size < this.maxEntries) {
      return this.buffer.slice(0, this.size).filter(
        (entry): entry is MetricEntry => entry !== undefined
      );
    }
    return [...this.buffer.slice(this.nextIndex), ...this.buffer.slice(0, this.nextIndex)].filter(
      (entry): entry is MetricEntry => entry !== undefined
    );
  }

  reset(): void {
    this.buffer.length = 0;
    this.size = 0;
    this.nextIndex = 0;
  }

  snapshot(): MetricsSnapshot {
    const entries = this.entries();
    const taskEntries = entries.filter((entry): entry is TaskMetric => entry.kind === "task");
    const stepEntries = entries.filter((entry): entry is StepMetric => entry.kind === "step");
    const toolEntries = entries.filter((entry): entry is ToolMetric => entry.kind === "tool");
    const tokenEntries = entries.filter((entry): entry is TokenMetric => entry.kind === "token");
    const costEntries = entries.filter((entry): entry is CostMetric => entry.kind === "cost");
    const eventEntries = entries.filter((entry): entry is EventMetric => entry.kind === "event");
    const taskDurations = taskEntries.flatMap((entry) =>
      entry.durationMs === undefined ? [] : [entry.durationMs]
    );
    const tokenTaskCount = new Set(tokenEntries.map((entry) => entry.taskId)).size;
    const totalInput = tokenEntries.reduce((total, entry) => total + entry.inputTokens, 0);
    const totalOutput = tokenEntries.reduce((total, entry) => total + entry.outputTokens, 0);
    const totalTokens = tokenEntries.reduce((total, entry) => total + entry.totalTokens, 0);
    const retriedSteps = stepEntries.filter((entry) => (entry.attempt ?? 1) > 1);
    const fallbackAttempts = eventCount(eventEntries, "model.fallback.attempt");
    const modelCalls = eventCount(eventEntries, "model.call");
    const fallbackCallIds = eventCallIds(eventEntries, "model.fallback.attempt");
    const modelCallIds = eventCallIds(eventEntries, "model.call");
    const repairAttempts = eventCount(eventEntries, "structured_output.repair.attempt");
    const repairSuccesses = eventCount(eventEntries, "structured_output.repair.success");

    return {
      snapshotTs: Date.now(),
      metrics: {
        tasks: {
          total: taskEntries.length,
          completed: countStatus(taskEntries, "completed"),
          failed: countStatus(taskEntries, "failed"),
          cancelled: countStatus(taskEntries, "cancelled"),
          running: countStatus(taskEntries, "running"),
        },
        steps: {
          total: stepEntries.length,
          completed: countStatus(stepEntries, "completed"),
          failed: countStatus(stepEntries, "failed"),
          retrying: countStatus(stepEntries, "retrying"),
        },
        tools: {
          total: toolEntries.length,
          success: countStatus(toolEntries, "success"),
          error: countStatus(toolEntries, "error"),
          timeout: countStatus(toolEntries, "timeout"),
          permissionDenied: countStatus(toolEntries, "permission_denied"),
        },
        tokens: {
          totalInput,
          totalOutput,
          totalTokens,
          avgTokensPerTask: tokenTaskCount === 0 ? 0 : totalTokens / tokenTaskCount,
        },
        cost: {
          totalCost: costEntries.reduce((total, entry) => total + entry.totalCost, 0),
          currency: costEntries[0]?.currency ?? DEFAULT_CURRENCY,
          modelCost: costEntries.reduce((total, entry) => total + entry.breakdown.modelCost, 0),
          toolCost: costEntries.reduce((total, entry) => total + entry.breakdown.toolCost, 0),
        },
        latency: {
          avgTaskDurationMs:
            taskDurations.length === 0
              ? 0
              : taskDurations.reduce((total, duration) => total + duration, 0) /
                taskDurations.length,
          ...(taskDurations.length > 0
            ? { p95TaskDurationMs: percentile95(taskDurations) }
            : {}),
        },
        rates: {
          taskSuccessRate: successRate(countStatus(taskEntries, "completed"), taskEntries.length),
          toolSuccessRate: successRate(countStatus(toolEntries, "success"), toolEntries.length),
          retryRecoveryRate: successRate(
            countStatus(retriedSteps, "completed"),
            retriedSteps.length
          ),
          ...(modelCallIds.size > 0
            ? { modelFallbackRate: fallbackCallIds.size / modelCallIds.size }
            : modelCalls > 0
              ? { modelFallbackRate: fallbackAttempts / modelCalls }
              : {}),
          ...(repairAttempts > 0
            ? { structuredOutputRepairSuccessRate: repairSuccesses / repairAttempts }
            : {}),
        },
      },
    };
  }
}

let globalMetricsCollector: MetricsCollector | undefined;

export function createMetricsCollector(options: MetricsCollectorOptions = {}): MetricsCollector {
  return new InMemoryMetricsCollector(options);
}

export function getMetricsCollector(): MetricsCollector {
  if (!globalMetricsCollector) {
    const runtimeConfig = getAgentRuntimeConfig();
    globalMetricsCollector = createMetricsCollector({
      isEnabled: runtimeConfig.metricsEnabled,
      maxEntries: runtimeConfig.metricsBufferSize,
    });
  }
  return globalMetricsCollector;
}

export function setMetricsCollector(collector: MetricsCollector): void {
  globalMetricsCollector = collector;
}
