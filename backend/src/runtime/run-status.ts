import {
  RUN_TERMINAL_STATUSES,
  type RunStatus,
  type RunStatusTransition,
  type RunTerminalStatus,
  type TaskStatus,
} from "@gun-ai/harness-contracts";

export {
  RUN_TERMINAL_STATUSES,
  RUN_WAITING_STATUSES,
} from "@gun-ai/harness-contracts";
export type {
  RunStatus,
  RunStatusTransition,
  RunTerminalStatus,
  RunWaitingStatus,
} from "@gun-ai/harness-contracts";

const TASK_STATUS_TO_RUN_STATUS: Record<TaskStatus, RunStatus> = {
  created: "running",
  running: "running",
  waiting_confirmation: "needs_user",
  completed: "completed",
  partially_failed: "running",
  compensating: "running",
  failed: "failed",
  cancelled: "cancelled",
  cancelling: "running",
  superseded: "superseded",
  rollback_requested: "running",
  cancelled_after_commit: "cancelled",
  manual_intervention_required: "manual_intervention_required",
};

export function isRunTerminalStatus(value: string): value is RunTerminalStatus {
  return RUN_TERMINAL_STATUSES.some((status) => status === value);
}

export function runStatusOf(taskStatus: TaskStatus): RunStatus {
  return TASK_STATUS_TO_RUN_STATUS[taskStatus];
}

export function runStatusReasonOf(taskStatus: TaskStatus): string | undefined {
  return taskStatus === "cancelled_after_commit" ? "cancelled_after_commit" : undefined;
}

export function transitionRunStatus(current: RunStatus, next: RunStatus): RunStatusTransition {
  if (isRunTerminalStatus(current) && next !== current) {
    return { accepted: false, status: current, reasonCode: "RUN_TERMINAL_MONOTONICITY" };
  }
  return { accepted: true, status: next };
}
