import { describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "../../platform/observability.js";
import type { BusinessEffectLedger } from "../side-effect/business-effect-ledger.js";
import type { EventRepository } from "../persistence/event-repository.js";
import type {
  PersistedAgentStep,
  StepRepository,
} from "../persistence/step-repository.js";
import type { TaskRepository } from "../persistence/task-repository.js";
import type {
  AgentStep,
  AgentTask,
  StepStatus,
  TaskEvent,
  TaskStatus,
} from "../types.js";
import type {
  CompensationAction,
  CompensationActionResult,
} from "./compensation-action.js";
import { CompensationRegistryImpl } from "./compensation-registry.js";
import { SagaOrchestratorImpl } from "./saga-orchestrator.js";

const createdAt = "2026-08-02T00:00:00.000Z";

function createStep(
  stepId: string,
  stepName: string,
  status: StepStatus
): AgentStep {
  return {
    stepId,
    stepName,
    status,
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    updatedAt: createdAt,
  };
}

function createTask(status: TaskStatus, steps: AgentStep[]): AgentTask {
  return {
    taskId: "task-1",
    taskType: "generic-task",
    status,
    steps,
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function createAction(
  actionId: string,
  execute: (context: unknown) => Promise<CompensationActionResult>,
  isReversible = true
): CompensationAction {
  return {
    actionId,
    description: `Compensate ${actionId}`,
    execute: vi.fn(execute),
    isReversible,
  };
}

function createHarness(task: AgentTask, steps: AgentStep[]) {
  const createTaskRecord = vi.fn(async (candidateTask: AgentTask) => candidateTask);
  const findTaskById = vi.fn(
    async (_taskId: string): Promise<AgentTask | null> => task
  );
  const updateTaskStatus = vi.fn(
    async (_taskId: string, status: TaskStatus): Promise<AgentTask> => ({
      ...task,
      status,
    })
  );
  const updateTaskRecord = vi.fn(
    async (
      _taskId: string,
      patch: Partial<Pick<AgentTask, "taskType" | "status" | "metadata">>
    ): Promise<AgentTask> => ({ ...task, ...patch })
  );
  const taskRepository: TaskRepository = {
    create: createTaskRecord,
    findById: findTaskById,
    updateStatus: updateTaskStatus,
    update: updateTaskRecord,
  };

  const createStepRecord = vi.fn(
    async (step: PersistedAgentStep): Promise<AgentStep> => step
  );
  const findStepById = vi.fn(
    async (stepId: string): Promise<AgentStep | null> =>
      steps.find((step) => step.stepId === stepId) ?? null
  );
  const findStepsByTaskId = vi.fn(async (_taskId: string) => steps);
  const updateStepStatus = vi.fn(
    async (stepId: string, status: StepStatus): Promise<AgentStep> => {
      const step = steps.find((candidateStep) => candidateStep.stepId === stepId);
      if (!step) {
        throw new Error(`Step not found: ${stepId}`);
      }
      return { ...step, status };
    }
  );
  const stepRepository: StepRepository = {
    create: createStepRecord,
    findById: findStepById,
    findByTaskId: findStepsByTaskId,
    updateStatus: updateStepStatus,
  };

  const appendEvent = vi.fn(async (event: TaskEvent) => event);
  const eventRepository: EventRepository = {
    append: appendEvent,
    findByTaskId: vi.fn(async () => []),
    async *streamByTaskId(): AsyncIterable<TaskEvent> {},
  };

  const recordAudit = vi.fn(
    async (_eventName: string, _payload: Record<string, unknown>) => undefined
  );
  const auditLogger: AuditLogger = { record: recordAudit };
  const sideEffectLedger = {
    prepare: vi.fn<BusinessEffectLedger["prepare"]>(),
    findExecutionByReplayKey: vi.fn<
      BusinessEffectLedger["findExecutionByReplayKey"]
    >(),
    recordAttempt: vi.fn<BusinessEffectLedger["recordAttempt"]>(),
    completeAttempt: vi.fn<BusinessEffectLedger["completeAttempt"]>(),
    linkAuthorizationDecision: vi.fn<
      BusinessEffectLedger["linkAuthorizationDecision"]
    >(),
    transitionExecution: vi.fn<BusinessEffectLedger["transitionExecution"]>(),
    transitionBusinessEffect: vi.fn<
      BusinessEffectLedger["transitionBusinessEffect"]
    >(),
    commitExecutionAndBusinessEffect: vi.fn<
      BusinessEffectLedger["commitExecutionAndBusinessEffect"]
    >(),
    transitionBusinessEffectAndExecution: vi.fn<
      BusinessEffectLedger["transitionBusinessEffectAndExecution"]
    >(),
    releaseClaim: vi.fn<BusinessEffectLedger["releaseClaim"]>(),
    findBusinessEffectSnapshot: vi.fn<
      BusinessEffectLedger["findBusinessEffectSnapshot"]
    >(async () => null),
    findCommittedExecutionByStepId: vi.fn<
      BusinessEffectLedger["findCommittedExecutionByStepId"]
    >(async () => null),
    prepareCompensationExecution: vi.fn<
      BusinessEffectLedger["prepareCompensationExecution"]
    >(async () => undefined),
    transitionCompensationExecution: vi.fn<
      BusinessEffectLedger["transitionCompensationExecution"]
    >(async () => undefined),
  } satisfies BusinessEffectLedger;
  const registry = new CompensationRegistryImpl();
  const orchestrator = new SagaOrchestratorImpl(
    registry,
    taskRepository,
    stepRepository,
    eventRepository,
    auditLogger,
    sideEffectLedger
  );

  return {
    appendEvent,
    findTaskById,
    findStepsByTaskId,
    orchestrator,
    recordAudit,
    registry,
    sideEffectLedger,
    updateStepStatus,
    updateTaskStatus,
  };
}

describe("SagaOrchestratorImpl", () => {
  it("compensates succeeded steps and their actions in reverse order", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "succeeded"),
      createStep("step-c", "step-c-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    const executionOrder: string[] = [];
    harness.registry.register(
      "step-a-type",
      createAction("action-a-1", async () => {
        executionOrder.push("action-a-1");
        return { status: "compensated" };
      })
    );
    harness.registry.register(
      "step-a-type",
      createAction("action-a-2", async (context) => {
        executionOrder.push("action-a-2");
        expect(context).toEqual({
          correlationId: "correlation-1",
          taskId: "task-1",
          stepId: "step-a",
        });
        return { status: "compensated" };
      })
    );
    harness.registry.register(
      "step-b-type",
      createAction("action-b-1", async () => {
        executionOrder.push("action-b-1");
        return { status: "compensated" };
      })
    );

    const result = await harness.orchestrator.compensate("task-1", {
      context: {
        correlationId: "correlation-1",
        taskId: "untrusted-task-id",
        stepId: "untrusted-step-id",
      },
    });

    expect(executionOrder).toEqual([
      "action-b-1",
      "action-a-2",
      "action-a-1",
    ]);
    expect(result).toEqual({
      taskId: "task-1",
      totalActions: 3,
      succeeded: 3,
      failed: 0,
      skippedIrreversible: 0,
      overallStatus: "all_compensated",
      failures: [],
      skippedIrreversibleActions: [],
    });
    expect(harness.updateTaskStatus.mock.calls).toEqual([
      ["task-1", "compensating"],
      ["task-1", "failed"],
    ]);
    expect(harness.updateStepStatus.mock.calls).toEqual([
      ["step-b", "compensating"],
      ["step-b", "compensated"],
      ["step-a", "compensating"],
      ["step-a", "compensated"],
    ]);
    expect(harness.appendEvent.mock.calls.map(([event]) => event.eventType)).toEqual([
      "compensation_triggered",
      "compensation_completed",
    ]);
    expect(harness.recordAudit).toHaveBeenCalledWith("compensation.triggered", {
      resourceType: "compensation",
      resourceId: "task-1",
      taskId: "task-1",
      failureStepId: "step-c",
      completedStepIds: ["step-a", "step-b"],
      reasonCode: "terminal_failed",
    });
    expect(harness.recordAudit).toHaveBeenCalledWith(
      "compensation.action_succeeded",
      {
        resourceType: "compensation_action",
        resourceId: "action-b-1",
        taskId: "task-1",
        stepId: "step-b",
        actionId: "action-b-1",
      }
    );
    expect(harness.recordAudit).toHaveBeenLastCalledWith("compensation.completed", {
      resourceType: "compensation",
      resourceId: "task-1",
      taskId: "task-1",
      result,
    });
  });

  it("returns no_actions_needed without state changes when no step succeeded", async () => {
    const steps = [createStep("step-a", "step-type", "terminal_failed")];
    const harness = createHarness(createTask("partially_failed", steps), steps);

    await expect(harness.orchestrator.compensate("task-1")).resolves.toEqual({
      taskId: "task-1",
      totalActions: 0,
      succeeded: 0,
      failed: 0,
      skippedIrreversible: 0,
      overallStatus: "no_actions_needed",
      failures: [],
      skippedIrreversibleActions: [],
    });
    expect(harness.updateTaskStatus).not.toHaveBeenCalled();
    expect(harness.updateStepStatus).not.toHaveBeenCalled();
    expect(harness.appendEvent).not.toHaveBeenCalled();
    expect(harness.recordAudit).not.toHaveBeenCalled();
  });

  it("marks a succeeded step compensated when it has no registered actions", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);

    const result = await harness.orchestrator.compensate("task-1");

    expect(result.overallStatus).toBe("no_actions_needed");
    expect(harness.updateStepStatus.mock.calls).toEqual([
      ["step-a", "compensating"],
      ["step-a", "compensated"],
    ]);
    expect(harness.updateTaskStatus.mock.calls).toEqual([
      ["task-1", "compensating"],
      ["task-1", "failed"],
    ]);
  });

  it("skips irreversible actions and records manual intervention", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    const irreversibleAction = createAction(
      "irreversible-action",
      async () => ({ status: "compensated" }),
      false
    );
    harness.registry.register("step-a-type", irreversibleAction);

    const result = await harness.orchestrator.compensate("task-1");

    expect(irreversibleAction.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalActions: 1,
      succeeded: 0,
      failed: 0,
      skippedIrreversible: 1,
      overallStatus: "manual_intervention_required",
      skippedIrreversibleActions: [
        {
          stepId: "step-a",
          actionId: "irreversible-action",
          reason: "irreversible_requires_manual_intervention",
        },
      ],
    });
    expect(harness.recordAudit).toHaveBeenCalledWith(
      "compensation.action_skipped_irreversible",
      {
        resourceType: "compensation_action",
        resourceId: "irreversible-action",
        taskId: "task-1",
        stepId: "step-a",
        actionId: "irreversible-action",
        reason: "irreversible_requires_manual_intervention",
      }
    );
    expect(harness.updateStepStatus).not.toHaveBeenCalledWith(
      "step-a",
      "compensated"
    );
  });

  it("executes reversible actions while skipping irreversible actions", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    const reversibleAction = createAction("reversible-action", async () => ({
      status: "compensated",
    }));
    const irreversibleAction = createAction(
      "irreversible-action",
      async () => ({ status: "compensated" }),
      false
    );
    harness.registry.register("step-a-type", reversibleAction);
    harness.registry.register("step-a-type", irreversibleAction);

    const result = await harness.orchestrator.compensate("task-1");

    expect(reversibleAction.execute).toHaveBeenCalledOnce();
    expect(irreversibleAction.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalActions: 2,
      succeeded: 1,
      failed: 0,
      skippedIrreversible: 1,
      overallStatus: "manual_intervention_required",
    });
  });

  it("records returned and thrown action failures and continues the chain", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "succeeded"),
      createStep("step-c", "step-c-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    const executionOrder: string[] = [];
    harness.registry.register(
      "step-a-type",
      createAction("successful-action", async () => {
        executionOrder.push("successful-action");
        return { status: "compensated" };
      })
    );
    harness.registry.register(
      "step-b-type",
      createAction("returned-failure", async () => {
        executionOrder.push("returned-failure");
        return {
          status: "failed",
          error: { message: "Rejected by provider", code: "provider_rejected" },
        };
      })
    );
    harness.registry.register(
      "step-b-type",
      createAction("thrown-failure", async () => {
        executionOrder.push("thrown-failure");
        throw new Error("External API unavailable");
      })
    );

    const result = await harness.orchestrator.compensate("task-1");

    expect(executionOrder).toEqual([
      "thrown-failure",
      "returned-failure",
      "successful-action",
    ]);
    expect(result).toMatchObject({
      totalActions: 3,
      succeeded: 1,
      failed: 2,
      skippedIrreversible: 0,
      overallStatus: "manual_intervention_required",
      failures: [
        {
          stepId: "step-b",
          actionId: "thrown-failure",
          error: { message: "External API unavailable" },
        },
        {
          stepId: "step-b",
          actionId: "returned-failure",
          error: {
            message: "Rejected by provider",
            code: "provider_rejected",
          },
        },
      ],
    });
    const emittedEventTypes = harness.appendEvent.mock.calls.map(
      ([event]) => event.eventType
    );
    expect(emittedEventTypes).toEqual([
      "compensation_triggered",
      "compensation_completed",
    ]);
    expect(harness.recordAudit).toHaveBeenCalledWith(
      "compensation.action_failed",
      expect.objectContaining({
        resourceType: "compensation_action",
        resourceId: "thrown-failure",
        taskId: "task-1",
        stepId: "step-b",
        actionId: "thrown-failure",
        error: { message: "External API unavailable" },
      })
    );
    expect(harness.updateStepStatus).not.toHaveBeenCalledWith(
      "step-b",
      "compensated"
    );
  });

  it("persists compensation lifecycle and injects committed execution ids", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    harness.sideEffectLedger.findCommittedExecutionByStepId.mockResolvedValue({
      toolExecutionId: "execution-1",
      businessEffectId: "effect-1",
    });
    const action = createAction("action-a", async (context) => {
      expect(context).toMatchObject({
        taskId: "task-1",
        stepId: "step-a",
        toolExecutionId: "execution-1",
        businessEffectId: "effect-1",
      });
      return { status: "failed", error: { message: "provider rejected" } };
    });
    harness.registry.register("step-a-type", action);

    const result = await harness.orchestrator.compensate("task-1");

    expect(result.overallStatus).toBe("manual_intervention_required");
    expect(
      harness.sideEffectLedger.prepareCompensationExecution
    ).toHaveBeenCalledWith({
      compensationExecutionId: expect.any(String),
      businessEffectId: "effect-1",
      toolExecutionId: "execution-1",
      compensationActionId: "action-a",
      context: {
        taskId: "task-1",
        stepId: "step-a",
        toolExecutionId: "execution-1",
        businessEffectId: "effect-1",
      },
    });
    expect(
      harness.sideEffectLedger.transitionCompensationExecution
    ).toHaveBeenLastCalledWith({
      compensationExecutionId: expect.any(String),
      expectedStatus: "executing",
      nextStatus: "manual_intervention_required",
    });
    expect(harness.updateStepStatus).not.toHaveBeenCalledWith(
      "step-a",
      "compensated"
    );
  });

  it("audits uncertainty when persisting manual compensation state fails", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "terminal_failed"),
    ];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    harness.sideEffectLedger.findCommittedExecutionByStepId.mockResolvedValue({
      toolExecutionId: "execution-1",
      businessEffectId: "effect-1",
    });
    harness.sideEffectLedger.transitionCompensationExecution
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ledger unavailable"));
    harness.registry.register(
      "step-a-type",
      createAction("action-a", async () => ({
        status: "failed",
        error: { message: "provider rejected" },
      }))
    );

    const result = await harness.orchestrator.compensate("task-1");

    expect(result.overallStatus).toBe("manual_intervention_required");
    expect(harness.recordAudit).toHaveBeenCalledWith(
      "compensation.persistence_uncertain",
      expect.objectContaining({
        resourceType: "compensation_execution",
        resourceId: expect.any(String),
        compensationExecutionId: expect.any(String),
        expectedStatus: "executing",
        nextStatus: "manual_intervention_required",
        errorName: "Error",
      })
    );
    expect(harness.updateStepStatus).not.toHaveBeenCalledWith(
      "step-a",
      "compensated"
    );
  });

  it("records user_cancelled in audit and triggered task event payload", async () => {
    const steps = [
      createStep("step-a", "step-a-type", "succeeded"),
      createStep("step-b", "step-b-type", "succeeded"),
    ];
    const harness = createHarness(createTask("cancelled", steps), steps);
    harness.registry.register(
      "step-a-type",
      createAction("action-a", async () => ({ status: "compensated" }))
    );
    harness.registry.register(
      "step-b-type",
      createAction("action-b", async () => ({ status: "compensated" }))
    );

    await harness.orchestrator.compensate("task-1", {
      reason: "user_cancelled",
    });

    expect(harness.recordAudit).toHaveBeenCalledWith("compensation.triggered", {
      resourceType: "compensation",
      resourceId: "task-1",
      taskId: "task-1",
      failureStepId: null,
      completedStepIds: ["step-a", "step-b"],
      reasonCode: "user_cancelled",
    });
    expect(harness.appendEvent.mock.calls[0]?.[0]).toMatchObject({
      eventType: "compensation_triggered",
      payload: {
        reasonCode: "user_cancelled",
      },
    });
  });

  it("rejects a task in an invalid status without side effects", async () => {
    const steps = [createStep("step-a", "step-a-type", "succeeded")];
    const harness = createHarness(createTask("running", steps), steps);

    await expect(harness.orchestrator.compensate("task-1")).rejects.toThrow(
      "Task status does not allow compensation: running"
    );
    expect(harness.findStepsByTaskId).not.toHaveBeenCalled();
    expect(harness.updateTaskStatus).not.toHaveBeenCalled();
    expect(harness.appendEvent).not.toHaveBeenCalled();
    expect(harness.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects an unknown task without side effects", async () => {
    const steps: AgentStep[] = [];
    const harness = createHarness(createTask("partially_failed", steps), steps);
    harness.findTaskById.mockResolvedValueOnce(null);

    await expect(harness.orchestrator.compensate("missing-task")).rejects.toThrow(
      "Task not found: missing-task"
    );
    expect(harness.findStepsByTaskId).not.toHaveBeenCalled();
    expect(harness.updateTaskStatus).not.toHaveBeenCalled();
  });
});
