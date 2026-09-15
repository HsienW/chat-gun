import { describe, expect, it } from "vitest";

import { createMetricsCollector } from "../../platform/metrics/metrics-collector.js";
import { renderOperationsMetrics } from "./export.js";

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
      signalStatus: "available",
      queueDepth: 0,
      activeRunCount: 0,
      stuckRunCount: 0,
      workerSaturation: 0.5,
      heartbeatFreshnessMs: 20,
      isHeartbeatStale: false,
      missingSignals: [],
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
});
