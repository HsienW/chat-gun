import type { AgentStep, AgentTask, StepError, TaskEvent, TaskEventType } from "./types.js";
import type { ExecutionContext } from "./execution-context/execution-context.js";
import { executionCorrelation } from "./execution-context/read-execution-context.js";

function createEvent(
  eventType: TaskEventType,
  taskId: string,
  options: { stepId?: string; payload?: unknown; executionContext?: ExecutionContext } = {}
): TaskEvent {
  return {
    eventId: globalThis.crypto.randomUUID(),
    taskId,
    ...(options.stepId ? { stepId: options.stepId } : {}),
    eventType,
    ...(options.executionContext
      ? { payload: {
          ...(options.payload && typeof options.payload === "object" && !Array.isArray(options.payload)
            ? options.payload : {}),
          correlation: executionCorrelation(options.executionContext),
        } }
      : options.payload !== undefined ? { payload: options.payload } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function createTaskCreatedEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("task_created", task.taskId, { payload: { task }, executionContext });
}

export function createStepStartedEvent(taskId: string, step: AgentStep, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("step_started", taskId, {
    stepId: step.stepId,
    payload: { step },
    executionContext,
  });
}

export function createStepCompletedEvent(taskId: string, step: AgentStep, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("step_completed", taskId, {
    stepId: step.stepId,
    payload: { step },
    executionContext,
  });
}

export function createStepFailedEvent(
  taskId: string,
  step: AgentStep,
  error: StepError,
  executionContext?: ExecutionContext
): TaskEvent {
  return createEvent("step_failed", taskId, {
    stepId: step.stepId,
    payload: { step, error },
    executionContext,
  });
}

export function createStepRetryingEvent(taskId: string, step: AgentStep, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("step_retrying", taskId, {
    stepId: step.stepId,
    payload: { step },
    executionContext,
  });
}

export function createTaskCompletedEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("task_completed", task.taskId, { payload: { task }, executionContext });
}

export function createTaskFailedEvent(task: AgentTask, error: StepError, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("task_failed", task.taskId, { payload: { task, error }, executionContext });
}

export function createTaskCancelledEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("task_cancelled", task.taskId, { payload: { task }, executionContext });
}

export function createCompensationTriggeredEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("compensation_triggered", task.taskId, { payload: { task }, executionContext });
}

export function createCompensationCompletedEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("compensation_completed", task.taskId, { payload: { task }, executionContext });
}

export function createWaitingConfirmationEvent(
  task: AgentTask,
  step?: AgentStep,
  executionContext?: ExecutionContext
): TaskEvent {
  return createEvent("waiting_confirmation", task.taskId, {
    ...(step ? { stepId: step.stepId } : {}),
    payload: step ? { task, step } : { task },
    executionContext,
  });
}

export function createResumedEvent(task: AgentTask, executionContext?: ExecutionContext): TaskEvent {
  return createEvent("resumed", task.taskId, { payload: { task }, executionContext });
}
