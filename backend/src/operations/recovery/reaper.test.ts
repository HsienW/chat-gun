import { describe, expect, it } from "vitest";

import { evaluateStuckRuns } from "./reaper.js";

const NOW = "2026-09-14T00:10:00.000Z";
const STALE = "2026-09-14T00:00:00.000Z";
const FRESH = "2026-09-14T00:09:30.000Z";
const POLICY = {
  heartbeatExpiryMs: 60_000,
  noProgressMs: 120_000,
  waitingTooLongMs: 180_000,
};

function createRun(overrides: Record<string, unknown> = {}) {
  const base = {
    taskId: "task-1",
    runId: "run-1",
    threadId: "thread-1",
    scopeId: "scope-1",
    runStatus: "running",
    ownership: {
      threadId: "thread-1",
      scopeId: "scope-1",
      taskId: "task-1",
      runId: "run-1",
      status: "active",
      generation: 1,
      updatedAt: FRESH,
    },
    lastProgressAt: FRESH,
    waitingState: "none",
    sideEffectState: "not_started",
    isReplaySafe: true,
    isRetryBudgetExhausted: false,
    hasUnsafeAmbiguity: false,
  };
  const run = {
    ...base,
    ...overrides,
  };
  if ("ownership" in overrides) return run;
  return {
    ...run,
    ownership: {
      ...base.ownership,
      taskId: String(run.taskId),
      runId: String(run.runId),
      threadId: String(run.threadId),
      scopeId: String(run.scopeId),
    },
  };
}

describe("stuck-run reaper projection", () => {
  it("classifies heartbeat-expired replay-safe work for requeue", () => {
    const run = createRun();
    const findings = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [
        {
          ...run,
          ownership: { ...run.ownership, updatedAt: STALE },
        },
      ],
    });

    expect(findings[0]).toMatchObject({
      reasons: ["heartbeat_expired"],
      classification: "requeue_safe",
      decision: "requeued",
    });
  });

  it("detects no-progress and orphaned ownership independently", () => {
    const findings = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [
        createRun({ runId: "no-progress", lastProgressAt: STALE }),
        createRun({ runId: "orphaned", ownership: undefined }),
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        runId: "no-progress",
        reasons: ["no_progress"],
        decision: "requeued",
      }),
      expect.objectContaining({
        runId: "orphaned",
        reasons: ["orphaned_ownership"],
        decision: "requeued",
      }),
    ]);
  });

  it("detects compensation or reconciliation waiting too long", () => {
    const findings = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [
        createRun({
          waitingState: "reconciliation",
          waitingSince: STALE,
          sideEffectState: "unknown",
        }),
      ],
    });

    expect(findings[0]).toMatchObject({
      reasons: ["waiting_too_long"],
      classification: "effect_unknown_requires_reconciliation",
      decision: "reconciliation_required",
    });
  });

  it("never requeues unsafe side effects and ignores healthy runs", () => {
    const findings = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [
        createRun({
          runId: "unsafe",
          lastProgressAt: STALE,
          isReplaySafe: false,
          hasUnsafeAmbiguity: true,
        }),
        createRun({ runId: "healthy" }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      runId: "unsafe",
      classification: "park_manual",
      decision: "parked_manual",
    });
  });
});
