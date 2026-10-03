import { z } from "zod";

import {
  classifyWorkerRecovery,
  mapWorkerRecoveryDecision,
} from "./worker-recovery.js";
import type {
  WorkerRecoveryClassification,
  WorkerRecoveryDecision,
} from "../types.js";
import type { SingletonLease } from "../../runtime/lock/singleton-lease.js";
import type { Queryable } from "../../runtime/persistence/rows.js";

const timestampSchema = z.string().datetime({ offset: true });
const ownershipSchema = z
  .object({
    threadId: z.string().trim().min(1),
    scopeId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    status: z.enum(["active", "superseded", "completed", "cancelled"]),
    generation: z.number().int().positive(),
    supersededByRunId: z.string().trim().min(1).optional(),
    updatedAt: timestampSchema,
  })
  .strict();
const runProjectionSchema = z
  .object({
    taskId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    scopeId: z.string().trim().min(1),
    runStatus: z.enum([
      "queued",
      "running",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]),
    ownership: ownershipSchema.optional(),
    lastProgressAt: timestampSchema,
    waitingState: z.enum(["none", "compensation", "reconciliation"]),
    waitingSince: timestampSchema.optional(),
    sideEffectState: z.enum([
      "none",
      "not_started",
      "committed",
      "unknown",
    ]),
    isReplaySafe: z.boolean(),
    isRetryBudgetExhausted: z.boolean(),
    hasUnsafeAmbiguity: z.boolean(),
  })
  .strict();
const reaperInputSchema = z
  .object({
    observedAt: timestampSchema,
    policy: z
      .object({
        heartbeatExpiryMs: z.number().finite().nonnegative(),
        noProgressMs: z.number().finite().nonnegative(),
        waitingTooLongMs: z.number().finite().nonnegative(),
      })
      .strict(),
    runs: z.array(runProjectionSchema),
  })
  .strict();

export type StuckRunReason =
  | "heartbeat_expired"
  | "no_progress"
  | "orphaned_ownership"
  | "waiting_too_long"
  | "terminal_status";

export interface StuckRunFinding {
  taskId: string;
  runId: string;
  reasons: StuckRunReason[];
  classification: WorkerRecoveryClassification;
  decision: WorkerRecoveryDecision | null;
  observedAt: string;
  ownershipGeneration: number | null;
  isSuperseded: boolean;
}

export interface RecoveryOwnershipPort {
  takeover(input: {
    runId: string;
    expectedGeneration: number | null;
    nextGeneration: number;
    decision: WorkerRecoveryDecision;
    observedAt: string;
  }): Promise<boolean>;
}

export class PgRecoveryOwnershipPort implements RecoveryOwnershipPort {
  constructor(private readonly database: Queryable) {}

  async takeover(input: {
    runId: string;
    expectedGeneration: number | null;
    nextGeneration: number;
    decision: WorkerRecoveryDecision;
    observedAt: string;
  }): Promise<boolean> {
    if (input.expectedGeneration === null) return false;
    const result = await this.database.query<{ run_id: string }>(
      `UPDATE active_run_ownership
       SET generation = $3, updated_at = $4
       WHERE run_id = $1
         AND generation = $2
         AND status = 'active'
         AND superseded_by_run_id IS NULL
       RETURNING run_id`,
      [input.runId, input.expectedGeneration, input.nextGeneration, input.observedAt]
    );
    return result.rows.length === 1;
  }
}

export interface TakeoverResult {
  runId: string;
  status: "taken_over" | "rejected" | "skipped";
  generation?: number;
  decision?: WorkerRecoveryDecision;
}

function isExpired(
  observedAtMs: number,
  signalAt: string,
  thresholdMs: number
): boolean {
  const ageMs = observedAtMs - Date.parse(signalAt);
  return ageMs >= 0 && ageMs >= thresholdMs;
}

function hasMatchingActiveOwnership(
  run: z.infer<typeof runProjectionSchema>
): boolean {
  const ownership = run.ownership;
  return Boolean(
    ownership &&
      ownership.status === "active" &&
      ownership.threadId === run.threadId &&
      ownership.scopeId === run.scopeId &&
      ownership.taskId === run.taskId &&
      ownership.runId === run.runId
  );
}

function detectStuckReasons(
  run: z.infer<typeof runProjectionSchema>,
  observedAtMs: number,
  policy: z.infer<typeof reaperInputSchema>["policy"]
): StuckRunReason[] {
  if (run.runStatus === "completed") return ["terminal_status"];
  const isActiveRun =
    run.runStatus === "running" || run.runStatus === "interrupted";
  const reasons: StuckRunReason[] = [];
  if (isActiveRun && !hasMatchingActiveOwnership(run)) {
    reasons.push("orphaned_ownership");
  }
  if (
    isActiveRun &&
    run.ownership?.status === "active" &&
    isExpired(observedAtMs, run.ownership.updatedAt, policy.heartbeatExpiryMs)
  ) {
    reasons.push("heartbeat_expired");
  }
  if (
    isActiveRun &&
    isExpired(observedAtMs, run.lastProgressAt, policy.noProgressMs)
  ) {
    reasons.push("no_progress");
  }
  if (
    run.waitingState !== "none" &&
    run.waitingSince &&
    isExpired(observedAtMs, run.waitingSince, policy.waitingTooLongMs)
  ) {
    reasons.push("waiting_too_long");
  }
  return reasons;
}

export function evaluateStuckRuns(inputValue: unknown): StuckRunFinding[] {
  const input = reaperInputSchema.parse(inputValue);
  const observedAtMs = Date.parse(input.observedAt);
  return input.runs.flatMap((run): StuckRunFinding[] => {
    const reasons = detectStuckReasons(run, observedAtMs, input.policy);
    if (reasons.length === 0) return [];
    const classification = classifyWorkerRecovery({
      isWorkerHealthy: false,
      isTaskCompleted: run.runStatus === "completed",
      sideEffectState: run.sideEffectState,
      isReplaySafe: run.isReplaySafe,
      isRetryBudgetExhausted: run.isRetryBudgetExhausted,
      hasUnsafeAmbiguity: run.hasUnsafeAmbiguity,
    });
    const mapping = mapWorkerRecoveryDecision(
      classification,
      run.runStatus === "interrupted" ? "resume" : "requeue"
    );
    return [
      {
        taskId: run.taskId,
        runId: run.runId,
        reasons,
        classification: mapping.classification,
        decision: mapping.decision,
        observedAt: input.observedAt,
        ownershipGeneration: run.ownership?.generation ?? null,
        isSuperseded:
          run.ownership?.status === "superseded" ||
          run.ownership?.supersededByRunId !== undefined,
      },
    ];
  });
}

export async function executeStuckRunTakeovers(
  findings: readonly StuckRunFinding[],
  ownership: RecoveryOwnershipPort
): Promise<TakeoverResult[]> {
  const outcomes: TakeoverResult[] = [];
  for (const finding of findings) {
    if (finding.isSuperseded || finding.decision === null) {
      outcomes.push({ runId: finding.runId, status: "skipped" });
      continue;
    }
    const nextGeneration = (finding.ownershipGeneration ?? 0) + 1;
    const acquired = await ownership.takeover({
      runId: finding.runId,
      expectedGeneration: finding.ownershipGeneration,
      nextGeneration,
      decision: finding.decision,
      observedAt: finding.observedAt,
    });
    outcomes.push({
      runId: finding.runId,
      status: acquired ? "taken_over" : "rejected",
      generation: nextGeneration,
      decision: finding.decision,
    });
  }
  return outcomes;
}

export async function runReaperCycle(input: {
  lease: SingletonLease;
  owner: string;
  ttlMs: number;
  findings: readonly StuckRunFinding[];
  ownership: RecoveryOwnershipPort;
}): Promise<{ leader: boolean; outcomes: TakeoverResult[] }> {
  const grant = await input.lease.acquire("reaper", input.owner, input.ttlMs);
  if (!grant) return { leader: false, outcomes: [] };
  const outcomes: TakeoverResult[] = [];
  for (const finding of input.findings) {
    if (!(await input.lease.renew(grant, input.ttlMs))) {
      return { leader: false, outcomes };
    }
    await input.lease.assertCurrent(grant);
    outcomes.push(...(await executeStuckRunTakeovers([finding], input.ownership)));
  }
  return {
    leader: true,
    outcomes,
  };
}
