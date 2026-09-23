import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { EventRepository } from "../persistence/event-repository.js";
import type { StepRepository } from "../persistence/step-repository.js";
import type { TaskRepository } from "../persistence/task-repository.js";
import type { AgentStep, AgentTask } from "../types.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import type { StructuredToolResultEnvelope } from "./structured-tool-result.js";
import { PgToolDispatchTaskStepAdapter } from "./task-step-adapter.js";

const now = "2026-09-23T00:00:00.000Z";
const context = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: now,
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "principal" as const,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
  },
};
const descriptor: RuntimeToolDescriptor = {
  toolName: "read_tool",
  toolVersion: "1.0",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  riskTier: "read",
  isReadOnly: true,
  isConcurrencySafe: () => true,
  timeoutPolicy: { timeoutMs: 1_000 },
  retryPolicy: {
    maxAttempts: 2,
    maxElapsedMs: 5_000,
    retryableCategories: [],
    backoffStrategy: "fixed",
    jitter: false,
  },
  interruptBehavior: "cancel_safe",
};

function createRepositories(task: AgentTask | null, step: AgentStep | null) {
  const createdTask: AgentTask = {
    taskId: context.taskId,
    taskType: "tool_dispatch",
    status: "running",
    steps: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  const createdStep: AgentStep = {
    stepId: context.stepId,
    stepName: descriptor.toolName,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    input: { value: "x" },
    createdAt: now,
    updatedAt: now,
  };
  const taskRepository: TaskRepository = {
    create: vi.fn(async () => createdTask),
    findById: vi.fn(async () => task),
    updateStatus: vi.fn(async () => createdTask),
    update: vi.fn(async () => createdTask),
  };
  const stepRepository: StepRepository = {
    create: vi.fn(async () => createdStep),
    findById: vi.fn(async () => step),
    findByTaskId: vi.fn(async () => (step ? [step] : [])),
    updateStatus: vi.fn(async (_stepId, status, options) => ({
      ...(step ?? createdStep),
      status,
      ...(options?.output !== undefined ? { output: options.output } : {}),
      ...(options?.error !== undefined ? { error: options.error } : {}),
    })),
  };
  const eventRepository: EventRepository = {
    append: vi.fn(async (event) => event),
    findByTaskId: vi.fn(async () => []),
    streamByTaskId: vi.fn(),
  };
  return { taskRepository, stepRepository, eventRepository };
}

describe("PgToolDispatchTaskStepAdapter", () => {
  it("creates missing task and step before emitting a step-started event", async () => {
    const repositories = createRepositories(null, null);
    const adapter = new PgToolDispatchTaskStepAdapter(repositories);

    await adapter.start(context, descriptor, { value: "x" });

    expect(repositories.taskRepository.create).toHaveBeenCalledOnce();
    expect(repositories.stepRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        stepId: "step-1",
        stepName: "read_tool",
        status: "running",
      })
    );
    expect(repositories.eventRepository.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "step_started", stepId: "step-1" })
    );
  });

  it("does not duplicate a start event for an already-running replayed step", async () => {
    const runningStep: AgentStep = {
      stepId: "step-1",
      stepName: "read_tool",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
    };
    const repositories = createRepositories(
      {
        taskId: "task-1",
        taskType: "tool_dispatch",
        status: "running",
        steps: [runningStep],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
      runningStep
    );
    const adapter = new PgToolDispatchTaskStepAdapter(repositories);

    await adapter.start(context, descriptor, { value: "x" });

    expect(repositories.stepRepository.create).not.toHaveBeenCalled();
    expect(repositories.eventRepository.append).not.toHaveBeenCalled();
  });

  it("persists the structured envelope when completing a running step", async () => {
    const runningStep: AgentStep = {
      stepId: "step-1",
      stepName: "read_tool",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
    };
    const repositories = createRepositories(null, runningStep);
    const adapter = new PgToolDispatchTaskStepAdapter(repositories);
    const envelope = {
      schemaVersion: "1.0",
      kind: "tool_result",
      correlation: {
        requestId: "request-1",
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-1",
        stepId: "step-1",
      },
      tool: { name: "read_tool", version: "1.0", riskTier: "read", readOnly: true },
      outcome: { type: "succeeded", result: "ok" },
      emittedAt: now,
    } satisfies StructuredToolResultEnvelope<string>;

    await adapter.complete(context, envelope);

    expect(repositories.stepRepository.updateStatus).toHaveBeenCalledWith(
      "step-1",
      "succeeded",
      { output: envelope }
    );
    expect(repositories.eventRepository.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "step_completed", stepId: "step-1" })
    );
  });
});
