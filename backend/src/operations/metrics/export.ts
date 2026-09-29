import type {
  EventMetric,
  MetricEntry,
  MetricsCollector,
} from "../../platform/metrics/metrics-collector.js";
import { executionIdSchema } from "../../runtime/execution-context/execution-context.js";
import type { RunStatus } from "../../runtime/run-status.js";
import type { RuntimeHealthProjection } from "./health.js";

export const CORRELATED_SLI_DIMENSIONS = [
  "run",
  "task",
  "step",
  "model",
  "tool",
  "permission",
  "reconciliation",
  "compensation",
  "context",
  "stream",
  "cost",
] as const;

export type CorrelatedSliDimension =
  (typeof CORRELATED_SLI_DIMENSIONS)[number];

export const RUN_OUTCOME_METRIC_CLASSES = [
  "success",
  "recovered_attempt_error",
  "terminal_failure",
  "user_visible_failure",
] as const;

export type RunOutcomeMetricClass =
  (typeof RUN_OUTCOME_METRIC_CLASSES)[number];

export interface CorrelatedMetricRecord {
  runId: string;
  dimension: CorrelatedSliDimension;
  referenceId: string;
  projection: Readonly<Record<string, string | number | boolean>>;
}

export interface CorrelatedMetricsProjection {
  runId: string;
  dimensions: Partial<
    Record<CorrelatedSliDimension, readonly CorrelatedMetricRecord[]>
  >;
}

export interface CorrelatedMetricsIndex {
  record(record: CorrelatedMetricRecord): void;
  query(runId: string): CorrelatedMetricsProjection;
}

const CORRELATED_PROJECTION_FIELDS = new Set([
  "status",
  "provider",
  "model",
  "toolName",
  "decision",
  "outcomeClass",
  "terminal",
  "errorCode",
  "durationMs",
  "value",
]);

const MAX_CORRELATED_RECORDS_PER_RUN = 1_000;

export function createCorrelatedMetricsIndex(): CorrelatedMetricsIndex {
  const recordsByRun = new Map<string, CorrelatedMetricRecord[]>();
  return {
    record(record) {
      executionIdSchema.parse(record.runId);
      executionIdSchema.parse(record.referenceId);
      if (!CORRELATED_SLI_DIMENSIONS.includes(record.dimension)) {
        throw new Error("CORRELATED_METRIC_DIMENSION_INVALID");
      }
      if (
        Object.keys(record.projection).some(
          (field) => !CORRELATED_PROJECTION_FIELDS.has(field)
        )
      ) {
        throw new Error("CORRELATED_METRIC_PROJECTION_FIELD_DENIED");
      }
      const current = recordsByRun.get(record.runId) ?? [];
      if (current.length >= MAX_CORRELATED_RECORDS_PER_RUN) {
        throw new Error("CORRELATED_METRIC_RUN_CAPACITY_EXCEEDED");
      }
      recordsByRun.set(record.runId, [
        ...current,
        {
          runId: record.runId,
          dimension: record.dimension,
          referenceId: record.referenceId,
          projection: { ...record.projection },
        },
      ]);
    },
    query(runId) {
      executionIdSchema.parse(runId);
      const dimensions: CorrelatedMetricsProjection["dimensions"] = {};
      for (const record of recordsByRun.get(runId) ?? []) {
        dimensions[record.dimension] = [
          ...(dimensions[record.dimension] ?? []),
          record,
        ];
      }
      return { runId, dimensions };
    },
  };
}

export function classifyRunOutcome(input: {
  terminal: RunStatus;
  hasRecoveredAttemptError?: boolean;
  hasUserVisibleFailure?: boolean;
}): RunOutcomeMetricClass {
  if (input.hasUserVisibleFailure) return "user_visible_failure";
  if (input.terminal !== "completed") return "terminal_failure";
  if (input.hasRecoveredAttemptError) return "recovered_attempt_error";
  return "success";
}

const COMPENSATION_EVENT_NAMES = new Set([
  "compensation.started",
  "compensation.completed",
  "compensation.failed",
]);
const RECONCILIATION_EVENT_NAMES = new Set([
  "side_effect.reconciliation.started",
  "side_effect.reconciliation.completed",
  "side_effect.reconciliation.failed",
]);

const RUN_OUTCOME_EVENT_NAMES: Record<RunOutcomeMetricClass, string> = {
  success: "run.outcome.success",
  recovered_attempt_error: "run.outcome.recovered_attempt_error",
  terminal_failure: "run.outcome.terminal_failure",
  user_visible_failure: "run.outcome.user_visible_failure",
};

function countEntries(
  entries: readonly MetricEntry[],
  predicate: (entry: MetricEntry) => boolean
): number {
  return entries.reduce((count, entry) => count + (predicate(entry) ? 1 : 0), 0);
}

function sumAllowlistedEvents(
  entries: readonly MetricEntry[],
  names: ReadonlySet<string>
): number {
  return entries
    .filter((entry): entry is EventMetric => entry.kind === "event" && names.has(entry.name))
    .reduce((total, entry) => total + entry.value, 0);
}

function metric(name: string, help: string, value: number): string[] {
  const safeValue = Number.isFinite(value) ? value : 0;
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${safeValue}`];
}

export function renderOperationsMetrics(
  collector: MetricsCollector,
  health: RuntimeHealthProjection
): string {
  const snapshot = collector.snapshot().metrics;
  const entries = collector.entries();
  const lines = [
    ...metric("chat_gun_task_total", "Observed runtime tasks.", snapshot.tasks.total),
    ...metric("chat_gun_task_success_ratio", "Completed task ratio.", snapshot.rates.taskSuccessRate),
    ...metric("chat_gun_step_total", "Observed runtime steps.", snapshot.steps.total),
    ...metric("chat_gun_tool_total", "Observed runtime tool executions.", snapshot.tools.total),
    ...metric("chat_gun_token_total", "Observed model tokens.", snapshot.tokens.totalTokens),
    ...metric("chat_gun_cost_total", "Observed runtime cost in configured currency.", snapshot.cost.totalCost),
    ...metric(
      "chat_gun_retry_total",
      "Observed retrying step entries.",
      countEntries(entries, (entry) => entry.kind === "step" && entry.status === "retrying")
    ),
    ...metric(
      "chat_gun_compensation_total",
      "Allowlisted compensation events.",
      sumAllowlistedEvents(entries, COMPENSATION_EVENT_NAMES)
    ),
    ...metric(
      "chat_gun_side_effect_reconciliation_total",
      "Allowlisted side-effect reconciliation events.",
      sumAllowlistedEvents(entries, RECONCILIATION_EVENT_NAMES)
    ),
    ...metric(
      "chat_gun_operations_signal_available",
      "Whether all configured operations health signals are available.",
      health.signalStatus === "available" ? 1 : 0
    ),
    ...RUN_OUTCOME_METRIC_CLASSES.flatMap((outcomeClass) =>
      metric(
        `chat_gun_run_outcome_${outcomeClass}_total`,
        `Observed ${outcomeClass} run outcomes.`,
        sumAllowlistedEvents(
          entries,
          new Set([RUN_OUTCOME_EVENT_NAMES[outcomeClass]])
        )
      )
    ),
  ];

  if (health.queueDepth !== undefined) {
    lines.push(...metric("chat_gun_queue_depth", "Pending native Agent Server runs.", health.queueDepth));
  }
  if (health.activeRunCount !== undefined) {
    lines.push(...metric("chat_gun_active_run_total", "Running native Agent Server runs.", health.activeRunCount));
  }
  if (health.stuckRunCount !== undefined) {
    lines.push(...metric("chat_gun_stuck_run_count", "Runs beyond the configured progress threshold.", health.stuckRunCount));
  }
  if (health.workerSaturation !== undefined) {
    lines.push(...metric("chat_gun_worker_saturation_ratio", "Configured worker capacity utilization.", health.workerSaturation));
  }
  if (health.heartbeatFreshnessMs !== undefined) {
    lines.push(...metric("chat_gun_worker_heartbeat_freshness_ms", "Age of the latest native heartbeat or X8.8 ownership progress projection.", health.heartbeatFreshnessMs));
  }

  return `${lines.join("\n")}\n# EOF\n`;
}
