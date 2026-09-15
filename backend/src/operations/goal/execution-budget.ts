import { z } from "zod";

import {
  parseCheckpointedExecutionBudget,
  parseExecutionBudget,
  type CheckpointedExecutionBudget,
  type ExecutionBudget,
  type ExecutionBudgetDimension,
  type ExecutionBudgetUsage,
} from "../types.js";

const usageDeltaSchema = z
  .object({
    turns: z.number().finite().nonnegative().optional(),
    tokens: z.number().finite().nonnegative().optional(),
    activeElapsedMs: z.number().finite().nonnegative().optional(),
    modelCalls: z.number().finite().nonnegative().optional(),
    toolCalls: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

export interface CreateCheckpointedExecutionBudgetInput {
  goalId: string;
  policyVersion: string;
  limits: ExecutionBudget;
  updatedAt: string;
}

export interface ExecutionBudgetUsageUpdate {
  usageDelta: Partial<ExecutionBudgetUsage>;
  updatedAt: string;
}

export interface RestoreExecutionBudgetIdentity {
  goalId: string;
  policyVersion: string;
}

export interface ExecutionBudgetDecision {
  status: "active" | "budget_exhausted";
  exhaustedDimensions: ExecutionBudgetDimension[];
  isSuccess: false;
  authorizesUnsafeReplay: false;
}

const ZERO_USAGE: ExecutionBudgetUsage = {
  turns: 0,
  tokens: 0,
  activeElapsedMs: 0,
  modelCalls: 0,
  toolCalls: 0,
  costUsd: 0,
};

function getExhaustedDimensions(
  limits: ExecutionBudget,
  usage: ExecutionBudgetUsage
): ExecutionBudgetDimension[] {
  const exhausted: ExecutionBudgetDimension[] = [];
  if (usage.turns >= limits.maxTurns) exhausted.push("turns");
  if (usage.tokens >= limits.maxTokens) exhausted.push("tokens");
  if (usage.activeElapsedMs >= limits.maxElapsedMs) {
    exhausted.push("active_elapsed_ms");
  }
  if (
    limits.maxModelCalls !== undefined &&
    usage.modelCalls >= limits.maxModelCalls
  ) {
    exhausted.push("model_calls");
  }
  if (
    limits.maxToolCalls !== undefined &&
    usage.toolCalls >= limits.maxToolCalls
  ) {
    exhausted.push("tool_calls");
  }
  if (
    limits.maxCostUsd !== undefined &&
    usage.costUsd >= limits.maxCostUsd
  ) {
    exhausted.push("cost_usd");
  }
  return exhausted;
}

export function createCheckpointedExecutionBudget(
  input: CreateCheckpointedExecutionBudgetInput
): CheckpointedExecutionBudget {
  const limits = parseExecutionBudget(input.limits);
  return parseCheckpointedExecutionBudget({
    schemaVersion: "1",
    goalId: input.goalId,
    policyVersion: input.policyVersion,
    limits,
    usage: ZERO_USAGE,
    exhaustedDimensions: getExhaustedDimensions(limits, ZERO_USAGE),
    updatedAt: input.updatedAt,
  });
}

export function applyExecutionBudgetUsage(
  currentInput: unknown,
  update: ExecutionBudgetUsageUpdate
): CheckpointedExecutionBudget {
  const current = parseCheckpointedExecutionBudget(currentInput);
  const delta = usageDeltaSchema.parse(update.usageDelta);
  const usage: ExecutionBudgetUsage = {
    turns: current.usage.turns + (delta.turns ?? 0),
    tokens: current.usage.tokens + (delta.tokens ?? 0),
    activeElapsedMs:
      current.usage.activeElapsedMs + (delta.activeElapsedMs ?? 0),
    modelCalls: current.usage.modelCalls + (delta.modelCalls ?? 0),
    toolCalls: current.usage.toolCalls + (delta.toolCalls ?? 0),
    costUsd: current.usage.costUsd + (delta.costUsd ?? 0),
  };
  return parseCheckpointedExecutionBudget({
    ...current,
    usage,
    exhaustedDimensions: getExhaustedDimensions(current.limits, usage),
    updatedAt: update.updatedAt,
  });
}

export const reduceExecutionBudgetState = applyExecutionBudgetUsage;

export function restoreCheckpointedExecutionBudget(
  checkpointInput: unknown,
  expected: RestoreExecutionBudgetIdentity
): CheckpointedExecutionBudget {
  const checkpoint = parseCheckpointedExecutionBudget(checkpointInput);
  if (checkpoint.goalId !== expected.goalId) {
    throw new Error("EXECUTION_BUDGET_GOAL_MISMATCH");
  }
  if (checkpoint.policyVersion !== expected.policyVersion) {
    throw new Error("EXECUTION_BUDGET_POLICY_MISMATCH");
  }
  return checkpoint;
}

export function getExecutionBudgetDecision(
  checkpointInput: unknown
): ExecutionBudgetDecision {
  const checkpoint = parseCheckpointedExecutionBudget(checkpointInput);
  return {
    status:
      checkpoint.exhaustedDimensions.length > 0
        ? "budget_exhausted"
        : "active",
    exhaustedDimensions: [...checkpoint.exhaustedDimensions],
    isSuccess: false,
    authorizesUnsafeReplay: false,
  };
}
