import {
  parseTaskGoal,
  type TaskGoal,
  type TaskGoalStatus,
} from "../types.js";

export interface CreateTaskGoalInput {
  goalId: string;
  taskId: string;
  objective: string;
  createdAt: string;
}

export interface UpdateTaskGoalInput {
  updatedAt: string;
  progressSummary?: string;
}

export interface ResumeTaskGoalInput extends UpdateTaskGoalInput {
  isBusinessIntentUnchanged: boolean;
}

export interface SettleTaskGoalInput extends UpdateTaskGoalInput {
  completionGateStatus: "passed" | "failed" | "invalid_policy";
  isBudgetExhausted: boolean;
}

export interface TaskGoalOperationsView {
  goalId: string;
  taskId: string;
  status: TaskGoalStatus;
  progressSummary?: string;
  updatedAt: string;
}

export function createTaskGoal(input: CreateTaskGoalInput): TaskGoal {
  return parseTaskGoal({
    ...input,
    status: "active",
    updatedAt: input.createdAt,
  });
}

export function pauseTaskGoal(
  goalInput: unknown,
  input: UpdateTaskGoalInput
): TaskGoal {
  const goal = parseTaskGoal(goalInput);
  if (goal.status !== "active") {
    throw new Error("TASK_GOAL_NOT_ACTIVE");
  }
  return parseTaskGoal({
    ...goal,
    status: "paused",
    updatedAt: input.updatedAt,
    progressSummary: input.progressSummary ?? goal.progressSummary,
  });
}

export function resumeTaskGoal(
  goalInput: unknown,
  input: ResumeTaskGoalInput
): TaskGoal {
  const goal = parseTaskGoal(goalInput);
  if (!input.isBusinessIntentUnchanged) {
    throw new Error("TASK_GOAL_INTENT_CHANGED");
  }
  if (goal.status !== "paused") {
    throw new Error("TASK_GOAL_NOT_PAUSED");
  }
  return parseTaskGoal({
    ...goal,
    status: "active",
    updatedAt: input.updatedAt,
    progressSummary: input.progressSummary ?? goal.progressSummary,
  });
}

export function settleTaskGoal(
  goalInput: unknown,
  input: SettleTaskGoalInput
): TaskGoal {
  const goal = parseTaskGoal(goalInput);
  if (goal.status !== "active") {
    throw new Error("TASK_GOAL_NOT_ACTIVE");
  }
  const status: TaskGoalStatus = input.isBudgetExhausted
    ? "budget_exhausted"
    : input.completionGateStatus === "passed"
      ? "completed"
      : "active";
  return parseTaskGoal({
    ...goal,
    status,
    updatedAt: input.updatedAt,
    progressSummary: input.progressSummary ?? goal.progressSummary,
  });
}

export function toTaskGoalOperationsView(
  goalInput: unknown
): TaskGoalOperationsView {
  const goal = parseTaskGoal(goalInput);
  return {
    goalId: goal.goalId,
    taskId: goal.taskId,
    status: goal.status,
    ...(goal.progressSummary
      ? { progressSummary: goal.progressSummary }
      : {}),
    updatedAt: goal.updatedAt,
  };
}
