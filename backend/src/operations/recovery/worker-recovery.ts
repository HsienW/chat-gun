import { z } from "zod";

import {
  parseWorkerRecoveryClassification,
  type WorkerRecoveryClassification,
  type WorkerRecoveryDecision,
} from "../types.js";

const recoveryInputSchema = z
  .object({
    isWorkerHealthy: z.boolean(),
    isTaskCompleted: z.boolean(),
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

const operationsViewInputSchema = z
  .object({
    taskId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    classification: z.enum([
      "healthy",
      "requeue_safe",
      "park_manual",
      "already_completed",
      "effect_unknown_requires_reconciliation",
    ]),
    reasonCode: z.string().trim().min(1),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type WorkerRecoveryInput = z.infer<typeof recoveryInputSchema>;

export interface WorkerRecoveryDecisionMapping {
  classification: WorkerRecoveryClassification;
  decision: WorkerRecoveryDecision | null;
}

export interface WorkerRecoveryOperationsView
  extends WorkerRecoveryDecisionMapping {
  taskId: string;
  runId: string;
  reasonCode: string;
  recordedAt: string;
}

export function classifyWorkerRecovery(
  inputValue: unknown
): WorkerRecoveryClassification {
  const input = recoveryInputSchema.parse(inputValue);
  if (input.isTaskCompleted) return "already_completed";
  if (input.sideEffectState === "unknown") {
    return "effect_unknown_requires_reconciliation";
  }
  if (input.isWorkerHealthy) return "healthy";
  if (input.isRetryBudgetExhausted || input.hasUnsafeAmbiguity) {
    return "park_manual";
  }
  return input.isReplaySafe ? "requeue_safe" : "park_manual";
}

export function mapWorkerRecoveryDecision(
  classificationValue: unknown,
  recoveryMode: "requeue" | "resume" = "requeue"
): WorkerRecoveryDecisionMapping {
  const classification = parseWorkerRecoveryClassification(
    classificationValue
  );
  switch (classification) {
    case "healthy":
      return { classification, decision: null };
    case "requeue_safe":
      return {
        classification,
        decision: recoveryMode === "resume" ? "resumed" : "requeued",
      };
    case "park_manual":
      return { classification, decision: "parked_manual" };
    case "already_completed":
      return { classification, decision: "completed_elsewhere" };
    case "effect_unknown_requires_reconciliation":
      return { classification, decision: "reconciliation_required" };
  }
}

export function createWorkerRecoveryOperationsView(
  inputValue: unknown
): WorkerRecoveryOperationsView {
  const input = operationsViewInputSchema.parse(inputValue);
  return {
    taskId: input.taskId,
    runId: input.runId,
    ...mapWorkerRecoveryDecision(input.classification),
    reasonCode: input.reasonCode,
    recordedAt: input.recordedAt,
  };
}
