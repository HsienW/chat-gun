import { describe, expect, it } from 'vitest';

import { TASK_STATUSES, type TaskStatus } from './task-types';
import {
  RUN_TERMINAL_STATUSES,
  runStatusOfTaskStatus,
  transitionRunStatus,
} from './runtime-run-status';

const expected: Record<TaskStatus, string> = {
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

describe('frontend RunStatus contract', () => {
  it('maps all 13 TaskStatus values from one source', () => {
    expect(Object.fromEntries(TASK_STATUSES.map((status) => [status, runStatusOfTaskStatus(status)])))
      .toEqual(expected);
  });

  it.each(['needs_user', 'manual_intervention_required'] as const)(
    'allows waiting status %s to resume',
    (status) => {
      expect(transitionRunStatus(status, 'running')).toEqual({
        accepted: true,
        status: 'running',
      });
    }
  );

  it.each(RUN_TERMINAL_STATUSES)('rejects %s returning to waiting', (status) => {
    expect(transitionRunStatus(status, 'needs_user')).toEqual({
      accepted: false,
      status,
      reasonCode: 'RUN_TERMINAL_MONOTONICITY',
    });
  });
});
