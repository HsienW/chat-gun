import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PgEventRepository } from "../persistence/event-repository.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { PgStepRepository } from "../persistence/step-repository.js";
import { PgTaskRepository } from "../persistence/task-repository.js";
import {
  transitionStep,
  transitionTask,
  transitionTaskStep,
} from "../state-machine.js";
import type { AgentStep, AgentTask } from "../types.js";

const createdAt = "2026-07-27T00:00:00.000Z";

function createStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    stepId: "step-1",
    stepName: "extract_intent",
    status: "pending",
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: "task-1",
    taskType: "recommendation",
    status: "created",
    steps: [createStep()],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("runtime task lifecycle integration", () => {
  it("creates a task, transitions steps, and reaches completed", () => {
    const task = createTask();
    const runningTask = transitionTask(task, "running");
    expect(runningTask.valid).toBe(true);

    const runningStepTask = runningTask.valid
      ? transitionTaskStep(runningTask.next, "step-1", "running")
      : runningTask;
    expect(runningStepTask.valid).toBe(true);

    const succeededStepTask = runningStepTask.valid
      ? transitionTaskStep(runningStepTask.next, "step-1", "succeeded")
      : runningStepTask;
    expect(succeededStepTask.valid && succeededStepTask.next.steps[0].status).toBe("succeeded");

    const completedTask = succeededStepTask.valid
      ? transitionTask(succeededStepTask.next, "completed")
      : succeededStepTask;
    expect(completedTask.valid && completedTask.next.status).toBe("completed");
  });

  it("rejects step transitions after task cancellation", () => {
    const cancelledTask = createTask({ status: "cancelled" });

    expect(transitionTaskStep(cancelledTask, "step-1", "running")).toEqual({
      valid: false,
      reason: "task is terminal: cancelled",
    });
  });

  it("moves retryable step failures to terminal_failed after maxAttempts", () => {
    const retryableFailure = transitionStep(
      createStep({ status: "retryable_failed", attempt: 2, maxAttempts: 2 }),
      "pending"
    );
    expect(retryableFailure).toEqual({
      valid: false,
      reason: "max attempts exceeded",
    });

    const terminalFailure = transitionStep(
      createStep({ status: "retryable_failed", attempt: 2, maxAttempts: 2 }),
      "terminal_failed",
      { error: { code: "timeout", message: "Timed out" } }
    );
    expect(terminalFailure.valid && terminalFailure.next.status).toBe("terminal_failed");
  });
});

// The PostgreSQL suite is opt-in and never reuses the runtime DATABASE_URL:
//   RUN_PG_INTEGRATION=true  enables the suite (any other value or unset skips it)
//   TEST_DATABASE_URL        connection string of an isolated, disposable PostgreSQL database
// The suite runs migrations and writes rows, so never point TEST_DATABASE_URL at a shared database.
const RUN_PG_INTEGRATION_ENV = "RUN_PG_INTEGRATION";
const TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL";

describe.runIf(process.env[RUN_PG_INTEGRATION_ENV] === "true")("runtime PostgreSQL integration", () => {
  it("persists task, step, and event records in the isolated test database", async () => {
    const connectionString = process.env[TEST_DATABASE_URL_ENV];
    if (!connectionString) {
      throw new Error(
        `${RUN_PG_INTEGRATION_ENV}=true requires ${TEST_DATABASE_URL_ENV} to point at an isolated PostgreSQL database.`
      );
    }

    // A dedicated pool keeps the runtime getPool() singleton and DATABASE_URL out of this suite.
    const pool = new Pool({ connectionString, max: 1 });
    try {
      await runPersistenceRoundTrip(pool);
    } finally {
      await pool.end();
    }
  });
});

async function runPersistenceRoundTrip(pool: Pool): Promise<void> {
  await runMigrations("up", pool);

  const taskRepository = new PgTaskRepository(pool);
  const stepRepository = new PgStepRepository(pool);
  const eventRepository = new PgEventRepository(pool);
  const taskId = `task-${globalThis.crypto.randomUUID()}`;
  const stepId = `step-${globalThis.crypto.randomUUID()}`;
  const task = createTask({ taskId, steps: [] });
  const step = createStep({ stepId });

  await taskRepository.create(task);
  await stepRepository.create({ ...step, taskId });
  await eventRepository.append({
    eventId: `event-${globalThis.crypto.randomUUID()}`,
    taskId,
    stepId,
    eventType: "step_started",
    payload: { step },
    createdAt,
  });

  await expect(taskRepository.findById(taskId)).resolves.toEqual(
    expect.objectContaining({
      taskId,
      steps: [expect.objectContaining({ stepId })],
    })
  );
  await expect(eventRepository.findByTaskId(taskId)).resolves.toHaveLength(1);

  await pool.query("DELETE FROM agent_tasks WHERE task_id = $1", [taskId]);
}
