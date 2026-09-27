import { describe, expect, it } from 'vitest';

import { taskEventReducer, type IncomingTaskEvent } from './task-event-reducer';
import type { AgentStep, AgentTask, TaskEvent, TaskEventType } from './task-types';

const createdAt = '2026-07-27T00:00:00.000Z';
const eventAt = '2026-07-27T01:00:00.000Z';

function createStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    stepId: 'step-1',
    stepName: 'extract_intent',
    status: 'pending',
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: 'task-1',
    taskType: 'recommendation',
    status: 'running',
    steps: [createStep()],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createEvent(
  eventType: TaskEventType,
  payload?: unknown,
  stepId = 'step-1'
): TaskEvent {
  return {
    eventId: `event-${eventType}`,
    taskId: 'task-1',
    stepId,
    eventType,
    payload,
    createdAt: eventAt,
  };
}

describe('taskEventReducer', () => {
  it('initializes state from task_created', () => {
    const task = createTask({ status: 'created', steps: [] });

    expect(taskEventReducer(null, createEvent('task_created', { task }))).toEqual(task);
  });

  it.each([
    ['step_started', 'running'],
    ['step_completed', 'succeeded'],
  ] as const)('handles %s', (eventType, status) => {
    const result = taskEventReducer(createTask(), createEvent(eventType));

    expect(result?.steps[0].status).toBe(status);
  });

  it('uses retryable_failed when step_failed payload carries retryable state', () => {
    const retryableStep = createStep({ status: 'retryable_failed' });
    const result = taskEventReducer(
      createTask(),
      createEvent('step_failed', {
        step: retryableStep,
        error: { code: 'timeout', message: 'Timed out' },
      })
    );

    expect(result?.steps[0]).toEqual(
      expect.objectContaining({
        status: 'retryable_failed',
        error: { code: 'timeout', message: 'Timed out' },
      })
    );
  });

  it('uses terminal_failed when step_failed has no retryable step state', () => {
    const result = taskEventReducer(
      createTask(),
      createEvent('step_failed', {
        error: { code: 'permission_denied', message: 'Denied' },
      })
    );

    expect(result?.steps[0].status).toBe('terminal_failed');
  });

  it('handles step_retrying by incrementing attempt and setting running', () => {
    const result = taskEventReducer(createTask(), createEvent('step_retrying'));

    expect(result?.steps[0]).toEqual(
      expect.objectContaining({
        status: 'running',
        attempt: 2,
      })
    );
  });

  it.each([
    ['task_completed', 'completed'],
    ['task_failed', 'failed'],
    ['task_cancelled', 'cancelled'],
    ['compensation_triggered', 'compensating'],
  ] as const)('handles %s', (eventType, status) => {
    const result = taskEventReducer(createTask(), createEvent(eventType));

    expect(result?.status).toBe(status);
  });

  it('handles waiting_confirmation for task and step', () => {
    const result = taskEventReducer(createTask(), createEvent('waiting_confirmation'));

    expect(result?.status).toBe('waiting_confirmation');
    expect(result?.steps[0].status).toBe('waiting_confirmation');
  });

  it('handles compensation_completed for task and step', () => {
    const result = taskEventReducer(createTask({ status: 'compensating' }), createEvent('compensation_completed'));

    expect(result?.status).toBe('failed');
    expect(result?.steps[0].status).toBe('compensated');
  });

  it('handles resumed by returning task to running', () => {
    const result = taskEventReducer(
      createTask({ status: 'waiting_confirmation' }),
      createEvent('resumed')
    );

    expect(result?.status).toBe('running');
  });

  it('allows manual intervention parking to resume', () => {
    const result = taskEventReducer(
      createTask({ status: 'manual_intervention_required' }),
      createEvent('resumed')
    );

    expect(result?.status).toBe('running');
  });

  it.each(['step_started', 'resumed', 'clarification_requested'] as const)(
    'ignores late %s after a hard terminal state',
    (eventType) => {
      const state = createTask({ status: 'completed' });

      expect(taskEventReducer(state, createEvent(eventType))).toBe(state);
    }
  );

  it.each([
    ['cancelling', 'cancelling'],
    ['cancelled', 'cancelled'],
    ['superseded', 'superseded'],
    ['rollback_requested', 'rollback_requested'],
    ['cancelled_after_commit', 'cancelled_after_commit'],
    ['manual_intervention_required', 'manual_intervention_required'],
  ] as const)('maps interaction event %s to task status %s', (eventType, status) => {
    const result = taskEventReducer(
      createTask(),
      createEvent(eventType, { generation: 3 })
    );

    expect(result?.status).toBe(status);
    expect(result?.metadata.activeGeneration).toBe(3);
  });

  it('tracks queued and clarification interaction states from structured events', () => {
    const queued = taskEventReducer(
      createTask(),
      createEvent('queued', { generation: 2 })
    );
    const clarification = taskEventReducer(
      queued,
      createEvent('clarification_requested', {
        generation: 2,
        confirmationType: 'input_classification',
      })
    );
    const resumed = taskEventReducer(
      clarification,
      createEvent('clarification_resumed', { generation: 2 })
    );

    expect(queued?.metadata.interactionState).toBe('queued');
    expect(clarification?.status).toBe('waiting_confirmation');
    expect(clarification?.metadata).toEqual(
      expect.objectContaining({
        interactionState: 'clarification_requested',
        confirmationType: 'input_classification',
      })
    );
    expect(resumed?.status).toBe('running');
    expect(resumed?.metadata.interactionState).toBe('clarification_resumed');
  });

  it('represents tentative classification as an explicit confirmation state', () => {
    const result = taskEventReducer(
      createTask(),
      createEvent('input_classification_tentative', {
        generation: 4,
        confirmationType: 'input_classification',
      })
    );

    expect(result?.status).toBe('waiting_confirmation');
    expect(result?.metadata.confirmationType).toBe('input_classification');
  });

  it('ignores lower-generation task events without overwriting current UI state', () => {
    const state = createTask({
      status: 'running',
      metadata: { activeGeneration: 5, interactionState: 'clarification_resumed' },
    });
    const stale = taskEventReducer(
      state,
      createEvent('superseded', { generation: 4 })
    );

    expect(stale).toBe(state);
  });

  it('safely ignores unknown event types', () => {
    const state = createTask();
    const unknownEvent: IncomingTaskEvent = {
      eventId: 'event-future',
      taskId: 'task-1',
      eventType: 'future_event',
      createdAt: eventAt,
    };

    expect(taskEventReducer(state, unknownEvent)).toBe(state);
  });

  it('does not create state from non-creation events', () => {
    expect(taskEventReducer(null, createEvent('step_started'))).toBeNull();
  });
});
