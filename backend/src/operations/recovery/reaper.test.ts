import { describe, expect, it, vi } from "vitest";

import { evaluateStuckRuns, executeStuckRunTakeovers, PgRecoveryOwnershipPort } from "./reaper.js";
import { runReaperCycle } from "./reaper.js";
import { SingletonLease } from "../../runtime/lock/singleton-lease.js";
import type { Queryable } from "../../runtime/persistence/rows.js";

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

  it("takes over with generation+1 and rejects superseded ownership", async () => {
    const findings = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [
        createRun({ ownership: { ...createRun().ownership, updatedAt: STALE } }),
        createRun({
          runId: "superseded",
          ownership: {
            ...createRun().ownership,
            runId: "superseded",
            status: "superseded",
            supersededByRunId: "run-new",
            updatedAt: STALE,
          },
        }),
      ],
    });
    const takeover = vi.fn(async () => true);
    const outcomes = await executeStuckRunTakeovers(findings, { takeover });

    expect(takeover).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", expectedGeneration: 1, nextGeneration: 2 })
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "taken_over", generation: 2 }),
      expect.objectContaining({ runId: "superseded", status: "skipped" }),
    ]);
  });

  it("executes takeover only while holding the reaper singleton lease", async () => {
    let token = 0;
    const lease = new SingletonLease(
      {
        set: vi.fn(async () => "OK" as const),
        eval: vi.fn(async () => 1),
        get: vi.fn(async () => null),
      },
      {
        next: async () => ++token,
        isCurrent: async (_name, candidate) => candidate === token,
      }
    );
    const finding = evaluateStuckRuns({
      observedAt: NOW,
      policy: POLICY,
      runs: [{ ...createRun(), ownership: { ...createRun().ownership, updatedAt: STALE } }],
    });
    const takeover = vi.fn(async () => true);
    await expect(runReaperCycle({ lease, owner: "instance-b", ttlMs: 1_000, findings: finding, ownership: { takeover } })).resolves.toMatchObject({ leader: true });
    expect(takeover).toHaveBeenCalledTimes(1);
  });

  it("uses a generation CAS and rejects superseded ownership in Postgres", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [{ run_id: "run-1" }], rowCount: 1 }));
    const port = new PgRecoveryOwnershipPort({ query: query as unknown as Queryable["query"] });
    await expect(port.takeover({ runId: "run-1", expectedGeneration: 3, nextGeneration: 4, decision: "resumed", observedAt: NOW })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AND generation = $2"),
      ["run-1", 3, 4, NOW]
    );
    expect(query.mock.calls[0]?.[0]).toContain("superseded_by_run_id IS NULL");
  });
});
