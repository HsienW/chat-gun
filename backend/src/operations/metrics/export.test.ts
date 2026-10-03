import { describe, expect, it } from "vitest";

import { createMetricsCollector } from "../../platform/metrics/metrics-collector.js";
import {
  CORRELATED_SLI_DIMENSIONS,
  createCorrelatedMetricsIndex,
  classifyRunOutcome,
  renderOperationsMetrics,
} from "./export.js";

const READY_HEALTH = {
  alive: { status: "ready" as const, reasonCodes: [] },
  reachable: { status: "ready" as const, reasonCodes: [] },
  acceptNewWork: { status: "ready" as const, reasonCodes: [] },
  resumeDurableWork: { status: "ready" as const, reasonCodes: [] },
  degraded: { status: "normal" as const, reasonCodes: [] },
  deploymentPolicySource: "environment" as const,
  multiInstanceSafe: true,
  missingSignals: [],
};

describe("renderOperationsMetrics", () => {
  it("exports aggregate OpenMetrics without raw identifiers or sensitive event attributes", () => {
    const collector = createMetricsCollector();
    collector.record({
      kind: "task",
      taskId: "private-task-id",
      status: "completed",
      durationMs: 250,
      ts: 1,
    });
    collector.record({
      kind: "event",
      name: "side_effect.reconciliation.completed",
      value: 1,
      attributes: {
        credential: "secret-value",
        prompt: "raw private prompt",
        principalId: "private-principal",
      },
      ts: 2,
    });

    const exposition = renderOperationsMetrics(collector, {
      ...READY_HEALTH,
      queueDepth: 0,
      activeRunCount: 0,
      stuckRunCount: 0,
      workerSaturation: 0.5,
      heartbeatFreshnessMs: 20,
      isHeartbeatStale: false,
    });

    expect(exposition).toContain("# TYPE chat_gun_task_total gauge");
    expect(exposition).toContain("chat_gun_task_total 1");
    expect(exposition).toContain("chat_gun_side_effect_reconciliation_total 1");
    expect(exposition).toContain("chat_gun_worker_saturation_ratio 0.5");
    expect(exposition).toContain("chat_gun_cost_total 0");
    expect(exposition).toContain("chat_gun_stuck_run_count 0");
    expect(exposition).toContain("chat_gun_worker_heartbeat_freshness_ms 20");
    expect(exposition).toMatch(/# EOF\n$/);
    expect(exposition).not.toContain("private-task-id");
    expect(exposition).not.toContain("secret-value");
    expect(exposition).not.toContain("raw private prompt");
    expect(exposition).not.toContain("private-principal");
  });

  it("exports four additive outcome metric families without runId labels", () => {
    const collector = createMetricsCollector();
    for (const outcomeClass of [
      "success",
      "recovered_attempt_error",
      "terminal_failure",
      "user_visible_failure",
    ] as const) {
      collector.record({
        kind: "event",
        name: `run.outcome.${outcomeClass}`,
        value: 1,
        attributes: { runId: `private-${outcomeClass}` },
        ts: 1,
      });
    }

    const exposition = renderOperationsMetrics(collector, {
      ...READY_HEALTH,
      isHeartbeatStale: false,
    });

    expect(exposition).toContain("chat_gun_run_outcome_success_total 1");
    expect(exposition).toContain("chat_gun_run_outcome_recovered_attempt_error_total 1");
    expect(exposition).toContain("chat_gun_run_outcome_terminal_failure_total 1");
    expect(exposition).toContain("chat_gun_run_outcome_user_visible_failure_total 1");
    expect(exposition).not.toContain("private-success");
    expect(exposition).not.toMatch(/runId\s*=/);
  });
});

describe("correlated SLI index", () => {
  it("queries the complete execution chain by canonical runId", () => {
    const index = createCorrelatedMetricsIndex();
    for (const dimension of CORRELATED_SLI_DIMENSIONS) {
      index.record({
        runId: "run-1",
        dimension,
        referenceId: `${dimension}-1`,
        projection: { status: "observed" },
      });
    }

    const projection = index.query("run-1");

    expect(Object.keys(projection.dimensions).sort()).toEqual(
      [...CORRELATED_SLI_DIMENSIONS].sort()
    );
    expect(projection.runId).toBe("run-1");
  });

  it("rejects sensitive or unbounded projection fields", () => {
    const index = createCorrelatedMetricsIndex();

    expect(() =>
      index.record({
        runId: "run-1",
        dimension: "tool",
        referenceId: "tool-1",
        projection: { credential: "must-not-index" },
      })
    ).toThrow("CORRELATED_METRIC_PROJECTION_FIELD_DENIED");
  });
});

describe("run outcome classification", () => {
  it("separates recovered, terminal, user-visible, and successful outcomes", () => {
    expect(
      classifyRunOutcome({ terminal: "completed", hasRecoveredAttemptError: true })
    ).toBe("recovered_attempt_error");
    expect(classifyRunOutcome({ terminal: "failed" })).toBe("terminal_failure");
    expect(
      classifyRunOutcome({ terminal: "completed", hasUserVisibleFailure: true })
    ).toBe("user_visible_failure");
    expect(classifyRunOutcome({ terminal: "completed" })).toBe("success");
  });
});
