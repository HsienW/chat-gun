import {
  createStepCompletedEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTaskCreatedEvent,
} from "../events.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { EventRepository } from "../persistence/event-repository.js";
import type { StepRepository } from "../persistence/step-repository.js";
import type { TaskRepository } from "../persistence/task-repository.js";
import type { AgentStep, AgentTask, StepError } from "../types.js";
import type { ToolDispatchTaskStepAdapter } from "./pipeline.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import type { StructuredToolResultEnvelope } from "./structured-tool-result.js";

export interface PgToolDispatchTaskStepAdapterDependencies {
  taskRepository: TaskRepository;
  stepRepository: StepRepository;
  eventRepository: EventRepository;
}

function currentIso(): string {
  return new Date().toISOString();
}

function createTask(context: ExecutionContext, createdAt: string): AgentTask {
  return {
    taskId: context.taskId,
    taskType: "tool_dispatch",
    status: "running",
    steps: [],
    metadata: {
      requestId: context.requestId,
      threadId: context.threadId,
      runId: context.runId,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function createStep(
  context: ExecutionContext,
  descriptor: RuntimeToolDescriptor,
  input: unknown,
  createdAt: string
): AgentStep & { taskId: string } {
  if (context.stepId === undefined) {
    throw new Error("Tool dispatch Task/Step requires stepId");
  }
  return {
    taskId: context.taskId,
    stepId: context.stepId,
    stepName: descriptor.toolName,
    status: "running",
    attempt: context.attempt,
    maxAttempts: descriptor.retryPolicy.maxAttempts,
    input,
    startedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function envelopeError(envelope: StructuredToolResultEnvelope): StepError {
  const outcome = envelope.outcome;
  if (outcome.type === "succeeded") {
    throw new Error("Cannot derive a failure from a successful Tool result");
  }
  if (outcome.type === "cancelled") {
    return {
      code: "TOOL_EXECUTION_CANCELLED",
      message: `Tool execution cancelled ${outcome.dispatchState} dispatch`,
      details: envelope,
    };
  }
  return {
    code:
      outcome.type === "confirmation_required"
        ? "REQUIRES_CONFIRMATION"
        : outcome.errorCode,
    message: `Tool dispatch failed: ${outcome.type}`,
    details: envelope,
  };
}

export class PgToolDispatchTaskStepAdapter
  implements ToolDispatchTaskStepAdapter
{
  constructor(
    private readonly dependencies: PgToolDispatchTaskStepAdapterDependencies
  ) {}

  async start(
    context: ExecutionContext,
    descriptor: RuntimeToolDescriptor,
    input: unknown
  ): Promise<void> {
    const createdAt = currentIso();
    const existingTask = await this.dependencies.taskRepository.findById(
      context.taskId
    );
    if (existingTask === null) {
      const task = await this.dependencies.taskRepository.create(
        createTask(context, createdAt)
      );
      await this.dependencies.eventRepository.append(
        createTaskCreatedEvent(task, context)
      );
    }

    if (context.stepId === undefined) {
      throw new Error("Tool dispatch Task/Step requires stepId");
    }
    const existingStep = await this.dependencies.stepRepository.findById(
      context.stepId
    );
    if (existingStep?.status === "running") {
      return;
    }
    if (existingStep !== null) {
      if (existingStep.status !== "pending") {
        return;
      }
      const runningStep = await this.dependencies.stepRepository.updateStatus(
        context.stepId,
        "running"
      );
      await this.dependencies.eventRepository.append(
        createStepStartedEvent(context.taskId, runningStep, context)
      );
      return;
    }

    const runningStep = await this.dependencies.stepRepository.create(
      createStep(context, descriptor, input, createdAt)
    );
    await this.dependencies.eventRepository.append(
      createStepStartedEvent(context.taskId, runningStep, context)
    );
  }

  async complete(
    context: ExecutionContext,
    envelope: StructuredToolResultEnvelope
  ): Promise<void> {
    if (context.stepId === undefined) {
      throw new Error("Tool dispatch Task/Step requires stepId");
    }
    const existingStep = await this.dependencies.stepRepository.findById(
      context.stepId
    );
    if (existingStep?.status === "succeeded") {
      return;
    }
    if (existingStep?.status !== "running") {
      throw new Error("Tool dispatch step is not running");
    }
    const completedStep = await this.dependencies.stepRepository.updateStatus(
      context.stepId,
      "succeeded",
      { output: envelope }
    );
    await this.dependencies.eventRepository.append(
      createStepCompletedEvent(context.taskId, completedStep, context)
    );
  }

  async fail(
    context: ExecutionContext,
    envelope: StructuredToolResultEnvelope
  ): Promise<void> {
    if (context.stepId === undefined) {
      throw new Error("Tool dispatch Task/Step requires stepId");
    }
    const existingStep = await this.dependencies.stepRepository.findById(
      context.stepId
    );
    if (existingStep?.status === "terminal_failed") {
      return;
    }
    if (existingStep?.status !== "running") {
      throw new Error("Tool dispatch step is not running");
    }
    const error = envelopeError(envelope);
    const failedStep = await this.dependencies.stepRepository.updateStatus(
      context.stepId,
      "terminal_failed",
      { error, output: envelope }
    );
    await this.dependencies.eventRepository.append(
      createStepFailedEvent(context.taskId, failedStep, error, context)
    );
  }
}
