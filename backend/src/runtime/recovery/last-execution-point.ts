import { z } from "zod";

import { STEP_STATUSES, TASK_STATUSES } from "../types.js";
import { INTERRUPT_MANIFEST_STATUSES } from "./interrupt-manifest.js";
import { decideReconciliationAction } from "../side-effect/reconciler.js";
import type {
  ReconciliationInput,
  SideEffectReconciler,
} from "../side-effect/side-effect-descriptor.js";

export const LAST_EXECUTION_POINTS = [
  "not_started",
  "executing",
  "committed",
  "unknown",
  "terminal",
  "waiting_user",
] as const;

export type LastExecutionPoint = (typeof LAST_EXECUTION_POINTS)[number];

const classifierEvidenceSchema = z
  .object({
    taskStatus: z.enum(TASK_STATUSES),
    stepStatus: z.enum(STEP_STATUSES).optional(),
    ledgerStatus: z.enum([
      "none",
      "prepared",
      "executing",
      "committed",
      "unknown",
    ]),
    checkpoint: z
      .object({
        exists: z.boolean(),
        hasPendingNodes: z.boolean(),
        isTerminal: z.boolean(),
      })
      .strict(),
    manifestStatus: z.enum(INTERRUPT_MANIFEST_STATUSES).optional(),
    sanitizeDiagnostic: z
      .object({
        status: z.enum(["valid", "sanitized"]),
        reasonCodes: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "cancelled_after_commit",
]);
const TERMINAL_STEP_STATUSES = new Set([
  "succeeded",
  "terminal_failed",
  "compensated",
  "skipped",
]);

export function classifyLastExecutionPoint(
  evidenceValue: unknown
): LastExecutionPoint {
  const evidence = classifierEvidenceSchema.parse(evidenceValue);
  if (
    evidence.checkpoint.isTerminal ||
    TERMINAL_TASK_STATUSES.has(evidence.taskStatus) ||
    (evidence.stepStatus !== undefined &&
      TERMINAL_STEP_STATUSES.has(evidence.stepStatus))
  ) {
    return "terminal";
  }
  if (evidence.ledgerStatus === "committed") return "committed";
  if (evidence.ledgerStatus === "unknown") return "unknown";
  if (evidence.manifestStatus === "waiting") return "waiting_user";
  if (
    evidence.taskStatus === "created" &&
    (evidence.stepStatus === undefined || evidence.stepStatus === "pending") &&
    evidence.ledgerStatus === "none" &&
    !evidence.checkpoint.exists
  ) {
    return "not_started";
  }
  if (
    evidence.taskStatus === "running" ||
    evidence.stepStatus === "running" ||
    evidence.ledgerStatus === "prepared" ||
    evidence.ledgerStatus === "executing" ||
    evidence.checkpoint.hasPendingNodes
  ) {
    return "executing";
  }
  return "unknown";
}

export type RecoveryContinuationDecision =
  | { action: "resume" }
  | { action: "wait"; reasonCode: "WAITING_USER" }
  | { action: "stop"; reasonCode: "TERMINAL_STATE" }
  | {
      action: "park";
      reasonCode: "RECONCILER_REQUIRED" | "UNKNOWN_EXECUTION_POINT";
    }
  | {
      action: "commit" | "retry" | "defer";
      reconciliationState: "committed" | "not_committed" | "unknown";
    };

export interface RouteRecoveryContinuationInput {
  classification: LastExecutionPoint;
  isMutation: boolean;
  reconciler?: SideEffectReconciler<unknown>;
  reconciliationInput: ReconciliationInput;
  canRetry: boolean;
}

export async function routeRecoveryContinuation(
  input: RouteRecoveryContinuationInput
): Promise<RecoveryContinuationDecision> {
  if (input.classification === "terminal") {
    return { action: "stop", reasonCode: "TERMINAL_STATE" };
  }
  if (input.classification === "waiting_user") {
    return { action: "wait", reasonCode: "WAITING_USER" };
  }
  if (
    (input.classification === "committed" ||
      input.classification === "unknown") &&
    input.isMutation
  ) {
    if (!input.reconciler) {
      return { action: "park", reasonCode: "RECONCILER_REQUIRED" };
    }
    const reconciliation = await input.reconciler.reconcile(
      input.reconciliationInput
    );
    return {
      action: decideReconciliationAction(reconciliation, input.canRetry),
      reconciliationState: reconciliation.state,
    };
  }
  if (input.classification === "unknown") {
    return { action: "park", reasonCode: "UNKNOWN_EXECUTION_POINT" };
  }
  return { action: "resume" };
}
