import { describe, expect, it } from 'vitest';

import { parseIncomingRuntimeEvent } from '../legacy-event-adapter';
import {
  STEP_STATUSES,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  type AgentTask,
} from '../task-types';

describe('task type compatibility', () => {
  it('keeps frontend task statuses aligned with the backend contract', () => {
    expect(TASK_STATUSES).toEqual([
      'created',
      'running',
      'waiting_confirmation',
      'completed',
      'partially_failed',
      'compensating',
      'failed',
      'cancelled',
      'cancelling',
      'superseded',
      'rollback_requested',
      'cancelled_after_commit',
      'manual_intervention_required',
    ]);
  });

  it('keeps frontend step statuses aligned with the backend contract', () => {
    expect(STEP_STATUSES).toEqual([
      'pending',
      'running',
      'waiting_confirmation',
      'succeeded',
      'retryable_failed',
      'terminal_failed',
      'compensating',
      'compensated',
      'skipped',
    ]);
  });

  it('keeps all task event types aligned with the backend contract', () => {
    expect(TASK_EVENT_TYPES).toEqual([
      'task_created',
      'step_started',
      'step_completed',
      'step_failed',
      'step_retrying',
      'task_completed',
      'task_failed',
      'task_cancelled',
      'compensation_triggered',
      'compensation_completed',
      'waiting_confirmation',
      'resumed',
      'queued',
      'cancelling',
      'cancelled',
      'superseded',
      'rollback_requested',
      'cancelled_after_commit',
      'manual_intervention_required',
      'input_classification_tentative',
      'clarification_requested',
      'clarification_resumed',
      'interaction_decision',
    ]);
  });

  it('supports typed step names without accepting unrelated steps', () => {
    type WeatherSteps = 'geocode' | 'fetch_forecast' | 'format_result';

    const task = {
      taskId: 'task-weather',
      taskType: 'weather',
      status: 'created',
      steps: [
        {
          stepId: 'step-geocode',
          stepName: 'geocode',
          status: 'pending',
          attempt: 1,
          maxAttempts: 2,
          createdAt: '2026-07-27T00:00:00.000Z',
          updatedAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      metadata: { userId: 'u1' },
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    } satisfies AgentTask<WeatherSteps>;

    expect(task.steps[0].stepName).toBe('geocode');
  });

  it('preserves an additive legacy event during the versioned migration window', () => {
    const event = {
      eventId: 'event-1',
      taskId: 'task-1',
      eventType: 'task_created',
      payload: { task: { taskId: 'task-1' } },
      createdAt: '2026-09-27T00:00:00.000Z',
      futureOptionalField: 'kept',
    };

    expect(parseIncomingRuntimeEvent(event, { enabled: true })).toEqual({
      kind: 'legacy',
      value: event,
    });
  });
});
