import {
  TASK_EVENT_TYPES,
  type AgentStep,
  type AgentTask,
  type StepError,
  type StepStatus,
  type TaskEvent,
  type TaskEventType,
  type TaskStatus,
} from './task-types';
import {
  isRunTerminalStatus,
  runStatusOfTaskStatus,
} from './runtime-run-status';

export type IncomingTaskEvent = TaskEvent | {
  eventId: string;
  taskId: string;
  stepId?: string;
  eventType: string;
  payload?: unknown;
  createdAt: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function isTaskEventType(value: string): value is TaskEventType {
  return TASK_EVENT_TYPES.includes(value as TaskEventType);
}

function getPayloadTask(value: unknown): AgentTask | undefined {
  return asRecord(asRecord(value)?.task) as AgentTask | undefined;
}

function getPayloadStep(value: unknown): AgentStep | undefined {
  return asRecord(asRecord(value)?.step) as AgentStep | undefined;
}

function getPayloadError(value: unknown): StepError | undefined {
  return asRecord(asRecord(value)?.error) as StepError | undefined;
}

function getPayloadGeneration(value: unknown): number | undefined {
  const generation = asRecord(value)?.generation;
  return typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? generation
    : undefined;
}

function getActiveGeneration(metadata: Record<string, unknown>): number | undefined {
  const generation = metadata.activeGeneration;
  return typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? generation
    : undefined;
}

function applyEventMetadata<TStep extends string>(
  state: AgentTask<TStep>,
  event: IncomingTaskEvent,
  interactionState?: string
): AgentTask<TStep> {
  const generation = getPayloadGeneration(event.payload);
  const confirmationType = asRecord(event.payload)?.confirmationType;
  return {
    ...state,
    metadata: {
      ...state.metadata,
      ...(generation === undefined ? {} : { activeGeneration: generation }),
      ...(interactionState === undefined ? {} : { interactionState }),
      ...(typeof confirmationType === 'string' ? { confirmationType } : {}),
    },
  };
}

function updateTaskStatus<TStep extends string>(
  state: AgentTask<TStep>,
  status: TaskStatus,
  updatedAt: string
): AgentTask<TStep> {
  return {
    ...state,
    status,
    updatedAt,
  };
}

function updateStep<TStep extends string>(
  state: AgentTask<TStep>,
  stepId: string | undefined,
  updater: (step: AgentStep<TStep>) => AgentStep<TStep>
): AgentTask<TStep> {
  if (!stepId) {
    return state;
  }

  return {
    ...state,
    steps: state.steps.map((step) =>
      step.stepId === stepId ? updater(step) : step
    ),
  };
}

function upsertStep<TStep extends string>(
  state: AgentTask<TStep>,
  incomingStep: AgentStep<TStep>
): AgentTask<TStep> {
  const hasStep = state.steps.some((step) => step.stepId === incomingStep.stepId);

  return {
    ...state,
    steps: hasStep
      ? state.steps.map((step) =>
          step.stepId === incomingStep.stepId ? incomingStep : step
        )
      : [...state.steps, incomingStep],
  };
}

function statusFromFailedStep(step: AgentStep | undefined): StepStatus {
  return step?.status === 'retryable_failed' ? 'retryable_failed' : 'terminal_failed';
}

function applyStepStatus<TStep extends string>(
  state: AgentTask<TStep>,
  event: IncomingTaskEvent,
  status: StepStatus
): AgentTask<TStep> {
  const incomingStep = getPayloadStep(event.payload) as AgentStep<TStep> | undefined;
  const error = getPayloadError(event.payload);

  if (incomingStep) {
    return upsertStep(state, {
      ...incomingStep,
      status,
      ...(error ? { error } : {}),
      updatedAt: event.createdAt,
    });
  }

  return updateStep(state, event.stepId, (step) => ({
    ...step,
    status,
    ...(error ? { error } : {}),
    updatedAt: event.createdAt,
  }));
}

export function taskEventReducer<TStep extends string>(
  state: AgentTask<TStep> | null,
  event: IncomingTaskEvent
): AgentTask<TStep> | null {
  if (!isTaskEventType(event.eventType)) {
    return state;
  }

  if (state && isRunTerminalStatus(runStatusOfTaskStatus(state.status))) {
    console.info({
      code: 'task_event.terminal_late_ignored',
      taskId: state.taskId,
      eventType: event.eventType,
    });
    return state;
  }

  if (event.eventType === 'task_created') {
    const task = getPayloadTask(event.payload) as AgentTask<TStep> | undefined;
    return task ? applyEventMetadata(task, event) : null;
  }

  if (!state) {
    return null;
  }

  const eventGeneration = getPayloadGeneration(event.payload);
  const activeGeneration = getActiveGeneration(state.metadata);
  if (
    eventGeneration !== undefined &&
    activeGeneration !== undefined &&
    eventGeneration < activeGeneration
  ) {
    return state;
  }
  const currentState = applyEventMetadata(state, event);

  switch (event.eventType) {
    case 'step_started':
      return applyStepStatus(currentState, event, 'running');
    case 'step_completed':
      return applyStepStatus(currentState, event, 'succeeded');
    case 'step_failed':
      return applyStepStatus(
        currentState,
        event,
        statusFromFailedStep(getPayloadStep(event.payload))
      );
    case 'step_retrying':
      return updateStep(currentState, event.stepId, (step) => ({
        ...step,
        status: 'running',
        attempt: getPayloadStep(event.payload)?.attempt ?? step.attempt + 1,
        updatedAt: event.createdAt,
      }));
    case 'task_completed':
      return updateTaskStatus(currentState, 'completed', event.createdAt);
    case 'task_failed':
      return updateTaskStatus(currentState, 'failed', event.createdAt);
    case 'task_cancelled':
      return updateTaskStatus(currentState, 'cancelled', event.createdAt);
    case 'compensation_triggered':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'compensation_waiting'),
        'compensating',
        event.createdAt
      );
    case 'compensation_completed':
      return updateTaskStatus(
        updateStep(currentState, event.stepId, (step) => ({
          ...step,
          status: 'compensated',
          updatedAt: event.createdAt,
        })),
        'failed',
        event.createdAt
      );
    case 'waiting_confirmation':
      return updateTaskStatus(
        updateStep(currentState, event.stepId, (step) => ({
          ...step,
          status: 'waiting_confirmation',
          updatedAt: event.createdAt,
        })),
        'waiting_confirmation',
        event.createdAt
      );
    case 'resumed':
      return updateTaskStatus(currentState, 'running', event.createdAt);
    case 'queued':
      return applyEventMetadata(currentState, event, 'queued');
    case 'cancelling':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'cancelling'),
        'cancelling',
        event.createdAt
      );
    case 'cancelled':
      return updateTaskStatus(currentState, 'cancelled', event.createdAt);
    case 'superseded':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'superseded'),
        'superseded',
        event.createdAt
      );
    case 'rollback_requested':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'compensation_waiting'),
        'rollback_requested',
        event.createdAt
      );
    case 'cancelled_after_commit':
      return updateTaskStatus(currentState, 'cancelled_after_commit', event.createdAt);
    case 'manual_intervention_required':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'corrective_manual'),
        'manual_intervention_required',
        event.createdAt
      );
    case 'input_classification_tentative':
      return updateTaskStatus(currentState, 'waiting_confirmation', event.createdAt);
    case 'clarification_requested':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'clarification_requested'),
        'waiting_confirmation',
        event.createdAt
      );
    case 'clarification_resumed':
      return updateTaskStatus(
        applyEventMetadata(currentState, event, 'clarification_resumed'),
        'running',
        event.createdAt
      );
    case 'interaction_decision':
      return applyEventMetadata(currentState, event, 'interaction_decision');
  }
}
