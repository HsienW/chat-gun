import { z } from "zod";

export const TASK_GOAL_STATUSES = [
  "active",
  "paused",
  "completed",
  "budget_exhausted",
  "failed",
  "cancelled",
] as const;

export const EXECUTION_BUDGET_DIMENSIONS = [
  "turns",
  "tokens",
  "active_elapsed_ms",
  "model_calls",
  "tool_calls",
  "cost_usd",
] as const;

export const WORKER_RECOVERY_CLASSIFICATIONS = [
  "healthy",
  "requeue_safe",
  "park_manual",
  "already_completed",
  "effect_unknown_requires_reconciliation",
] as const;

export const WORKER_RECOVERY_DECISIONS = [
  "requeued",
  "resumed",
  "parked_manual",
  "completed_elsewhere",
  "reconciliation_required",
] as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const finiteNonNegativeSchema = z.number().finite().nonnegative();

export const taskGoalSchema = z
  .object({
    goalId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    objective: nonEmptyStringSchema,
    status: z.enum(TASK_GOAL_STATUSES),
    progressSummary: nonEmptyStringSchema.optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const executionBudgetSchema = z
  .object({
    maxTurns: finiteNonNegativeSchema,
    maxTokens: finiteNonNegativeSchema,
    maxElapsedMs: finiteNonNegativeSchema,
    maxModelCalls: finiteNonNegativeSchema.optional(),
    maxToolCalls: finiteNonNegativeSchema.optional(),
    maxCostUsd: finiteNonNegativeSchema.optional(),
  })
  .strict();

export const executionBudgetUsageSchema = z
  .object({
    turns: finiteNonNegativeSchema,
    tokens: finiteNonNegativeSchema,
    activeElapsedMs: finiteNonNegativeSchema,
    modelCalls: finiteNonNegativeSchema,
    toolCalls: finiteNonNegativeSchema,
    costUsd: finiteNonNegativeSchema,
  })
  .strict();

export const checkpointedExecutionBudgetSchema = z
  .object({
    schemaVersion: z.literal("1"),
    goalId: nonEmptyStringSchema,
    policyVersion: nonEmptyStringSchema,
    limits: executionBudgetSchema,
    usage: executionBudgetUsageSchema,
    exhaustedDimensions: z
      .array(z.enum(EXECUTION_BUDGET_DIMENSIONS))
      .refine(
        (dimensions) => new Set(dimensions).size === dimensions.length,
        "exhaustedDimensions must not contain duplicates"
      ),
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const executionManifestSchema = z
  .object({
    runtimeBuildId: nonEmptyStringSchema,
    graphVersion: nonEmptyStringSchema,
    promptVersion: nonEmptyStringSchema,
    modelRouteVersion: nonEmptyStringSchema,
    toolSchemaVersion: nonEmptyStringSchema,
    policyVersion: nonEmptyStringSchema,
    domainSchemaVersion: nonEmptyStringSchema.optional(),
    catalogVersion: nonEmptyStringSchema.optional(),
    embeddingVersion: nonEmptyStringSchema.optional(),
    rerankerVersion: nonEmptyStringSchema.optional(),
  })
  .strict();

export const workerRecoveryClassificationSchema = z.enum(
  WORKER_RECOVERY_CLASSIFICATIONS
);

export const workerRecoveryDecisionSchema = z.enum(WORKER_RECOVERY_DECISIONS);

export type TaskGoalStatus = (typeof TASK_GOAL_STATUSES)[number];
export type TaskGoal = z.infer<typeof taskGoalSchema>;
export type ExecutionBudgetDimension =
  (typeof EXECUTION_BUDGET_DIMENSIONS)[number];
export type ExecutionBudget = z.infer<typeof executionBudgetSchema>;
export type ExecutionBudgetUsage = z.infer<typeof executionBudgetUsageSchema>;
export type CheckpointedExecutionBudget = z.infer<
  typeof checkpointedExecutionBudgetSchema
>;
export type ExecutionManifest = z.infer<typeof executionManifestSchema>;
export type WorkerRecoveryClassification =
  (typeof WORKER_RECOVERY_CLASSIFICATIONS)[number];
export type WorkerRecoveryDecision =
  (typeof WORKER_RECOVERY_DECISIONS)[number];

export function parseTaskGoal(value: unknown): TaskGoal {
  return taskGoalSchema.parse(value);
}

export function parseExecutionBudget(value: unknown): ExecutionBudget {
  return executionBudgetSchema.parse(value);
}

export function parseCheckpointedExecutionBudget(
  value: unknown
): CheckpointedExecutionBudget {
  return checkpointedExecutionBudgetSchema.parse(value);
}

export function parseExecutionManifest(value: unknown): ExecutionManifest {
  return executionManifestSchema.parse(value);
}

export function parseWorkerRecoveryClassification(
  value: unknown
): WorkerRecoveryClassification {
  return workerRecoveryClassificationSchema.parse(value);
}

export function parseWorkerRecoveryDecision(
  value: unknown
): WorkerRecoveryDecision {
  return workerRecoveryDecisionSchema.parse(value);
}
