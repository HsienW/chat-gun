import { describe, expect, it } from "vitest";

import {
  classifyWorkerRecovery,
  createWorkerRecoveryOperationsView,
  mapWorkerRecoveryDecision,
} from "./worker-recovery.js";

const BASE_INPUT = {
  isWorkerHealthy: false,
  isTaskCompleted: false,
  sideEffectState: "not_started" as const,
  isReplaySafe: false,
  isRetryBudgetExhausted: false,
  hasUnsafeAmbiguity: false,
};

describe("worker recovery classification", () => {
  it("maps healthy to no action and replay-safe work to requeue or resume", () => {
    expect(
      mapWorkerRecoveryDecision(
        classifyWorkerRecovery({ ...BASE_INPUT, isWorkerHealthy: true })
      )
    ).toEqual({ classification: "healthy", decision: null });

    const replaySafe = classifyWorkerRecovery({
      ...BASE_INPUT,
      isReplaySafe: true,
    });
    expect(mapWorkerRecoveryDecision(replaySafe, "requeue")).toEqual({
      classification: "requeue_safe",
      decision: "requeued",
    });
    expect(mapWorkerRecoveryDecision(replaySafe, "resume")).toEqual({
      classification: "requeue_safe",
      decision: "resumed",
    });
  });

  it("requires X8.6 reconciliation before unknown effects can continue", () => {
    const classification = classifyWorkerRecovery({
      ...BASE_INPUT,
      sideEffectState: "unknown",
      isReplaySafe: true,
    });

    expect(classification).toBe(
      "effect_unknown_requires_reconciliation"
    );
    expect(mapWorkerRecoveryDecision(classification)).toEqual({
      classification,
      decision: "reconciliation_required",
    });
  });

  it("parks exhausted or unsafe ambiguous work instead of replaying it", () => {
    for (const input of [
      { ...BASE_INPUT, isRetryBudgetExhausted: true, isReplaySafe: true },
      { ...BASE_INPUT, hasUnsafeAmbiguity: true, isReplaySafe: true },
    ]) {
      const classification = classifyWorkerRecovery(input);
      expect(classification).toBe("park_manual");
      expect(mapWorkerRecoveryDecision(classification).decision).toBe(
        "parked_manual"
      );
    }
  });

  it("exposes manual parking in a bounded operations view", () => {
    expect(
      createWorkerRecoveryOperationsView({
        taskId: "task-1",
        runId: "run-1",
        classification: "park_manual",
        reasonCode: "RETRY_BUDGET_EXHAUSTED",
        recordedAt: "2026-09-14T00:00:00.000Z",
      })
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      classification: "park_manual",
      decision: "parked_manual",
      reasonCode: "RETRY_BUDGET_EXHAUSTED",
      recordedAt: "2026-09-14T00:00:00.000Z",
    });
  });
});
