import type { TaskStatus } from './task-types';

export const RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'crashed',
  'budget_exhausted',
  'superseded',
] as const;

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];
export const RUN_WAITING_STATUSES = [
  'needs_user',
  'manual_intervention_required',
] as const;

export type RunWaitingStatus = (typeof RUN_WAITING_STATUSES)[number];
export type RunStatus = 'running' | RunWaitingStatus | RunTerminalStatus;

const TASK_STATUS_TO_RUN_STATUS: Record<TaskStatus, RunStatus> = {
  created: 'running',
  running: 'running',
  waiting_confirmation: 'needs_user',
  completed: 'completed',
  partially_failed: 'running',
  compensating: 'running',
  failed: 'failed',
  cancelled: 'cancelled',
  cancelling: 'running',
  superseded: 'superseded',
  rollback_requested: 'running',
  cancelled_after_commit: 'cancelled',
  manual_intervention_required: 'manual_intervention_required',
};

export type RunStatusTransition =
  | { accepted: true; status: RunStatus }
  | {
      accepted: false;
      status: RunTerminalStatus;
      reasonCode: 'RUN_TERMINAL_MONOTONICITY';
    };

export function isRunTerminalStatus(value: string): value is RunTerminalStatus {
  return RUN_TERMINAL_STATUSES.some((status) => status === value);
}

export function isRunStatus(value: string): value is RunStatus {
  return (
    value === 'running' ||
    RUN_WAITING_STATUSES.some((status) => status === value) ||
    isRunTerminalStatus(value)
  );
}

export function runStatusOfTaskStatus(taskStatus: TaskStatus): RunStatus {
  return TASK_STATUS_TO_RUN_STATUS[taskStatus];
}

export function transitionRunStatus(
  current: RunStatus,
  next: RunStatus
): RunStatusTransition {
  if (isRunTerminalStatus(current) && next !== current) {
    return {
      accepted: false,
      status: current,
      reasonCode: 'RUN_TERMINAL_MONOTONICITY',
    };
  }
  return { accepted: true, status: next };
}
