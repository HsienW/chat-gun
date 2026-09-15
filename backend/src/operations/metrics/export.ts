import type {
  EventMetric,
  MetricEntry,
  MetricsCollector,
} from "../../platform/metrics/metrics-collector.js";
import type { RuntimeHealthProjection } from "./health.js";

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
