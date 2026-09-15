import { z } from "zod";

import {
  classifyWorkerRecovery,
  mapWorkerRecoveryDecision,
} from "./worker-recovery.js";
import type {
  WorkerRecoveryClassification,
  WorkerRecoveryDecision,
} from "../types.js";

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
      },
    ];
  });
}
