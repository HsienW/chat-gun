import { describe, expect, it, vi } from "vitest";

import { transitionStep, transitionTask } from "./state-machine.js";
import type { AgentStep, AgentTask, StepError, StepStatus, TaskStatus } from "./types.js";

const createdAt = "2026-07-27T00:00:00.000Z";

function createTask(status: TaskStatus): AgentTask {
  return {
    taskId: "task-1",
    taskType: "recommendation",
    status,
    steps: [],
    metadata: { userId: "u1" },
    createdAt,
    updatedAt: createdAt,
  };
}

function createStep(status: StepStatus, overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    stepId: "step-1",
    stepName: "extract_intent",
    status,
    attempt: 1,
    maxAttempts: 2,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("transitionTask", () => {
  it("returns a new task for valid transitions and updates updatedAt", () => {
    vi.setSystemTime(new Date("2026-07-27T01:00:00.000Z"));
    const task = createTask("created");

    const result = transitionTask(task, "running");

    expect(result).toEqual({
      valid: true,
      next: {
        ...task,
        status: "running",
        updatedAt: "2026-07-27T01:00:00.000Z",
      },
    });
    expect(result.valid && result.next).not.toBe(task);
    expect(task.status).toBe("created");
  });

  it.each([
    ["created", "running"],
    ["created", "cancelled"],
    ["running", "waiting_confirmation"],
    ["running", "completed"],
    ["running", "partially_failed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["waiting_confirmation", "running"],
    ["waiting_confirmation", "completed"],
    ["waiting_confirmation", "cancelled"],
    ["partially_failed", "compensating"],
    ["compensating", "failed"],
    ["running", "cancelling"],
    ["cancelling", "cancelled"],
    ["running", "superseded"],
    ["running", "rollback_requested"],
    ["rollback_requested", "compensating"],
    ["compensating", "cancelled"],
    ["running", "cancelled_after_commit"],
    ["running", "manual_intervention_required"],
    ["manual_intervention_required", "cancelled"],
    ["manual_intervention_required", "failed"],
    ["manual_intervention_required", "running"],
  ] satisfies [TaskStatus, TaskStatus][])("allows %s -> %s", (from, to) => {
    expect(transitionTask(createTask(from), to).valid).toBe(true);
  });

  it.each([
    ["completed", "running"],
    ["failed", "running"],
    ["cancelled", "running"],
    ["running", "compensating"],
    ["waiting_confirmation", "failed"],
    ["superseded", "running"],
    ["cancelled_after_commit", "running"],
    ["rollback_requested", "completed"],
    ["cancelling", "running"],
  ] satisfies [TaskStatus, TaskStatus][])("rejects %s -> %s", (from, to) => {
    const task = createTask(from);

    const result = transitionTask(task, to);

    expect(result).toEqual({
      valid: false,
      reason: `invalid task transition: ${from} -> ${to}`,
    });
    expect(task.status).toBe(from);
  });
});

describe("transitionStep", () => {
  it.each([
    ["pending", "running"],
    ["pending", "skipped"],
    ["running", "waiting_confirmation"],
    ["running", "succeeded"],
    ["running", "retryable_failed"],
    ["running", "terminal_failed"],
    ["running", "compensating"],
    ["running", "skipped"],
    ["waiting_confirmation", "succeeded"],
    ["retryable_failed", "pending"],
    ["retryable_failed", "terminal_failed"],
    ["compensating", "compensated"],
  ] satisfies [StepStatus, StepStatus][])("allows %s -> %s", (from, to) => {
    expect(transitionStep(createStep(from), to).valid).toBe(true);
  });

  it("increments attempt only when retrying from retryable_failed to pending", () => {
    const result = transitionStep(createStep("retryable_failed", { attempt: 1, maxAttempts: 3 }), "pending");

    expect(result.valid && result.next.attempt).toBe(2);
  });

  it("rejects retry when attempt has reached maxAttempts", () => {
    const result = transitionStep(createStep("retryable_failed", { attempt: 2, maxAttempts: 2 }), "pending");

    expect(result).toEqual({ valid: false, reason: "max attempts exceeded" });
  });

  it("records error, output and completion timestamp without mutating the original step", () => {
    vi.setSystemTime(new Date("2026-07-27T02:00:00.000Z"));
    const error: StepError = { code: "timeout", message: "Timed out" };
    const step = createStep("running");

    const result = transitionStep(step, "terminal_failed", {
      error,
      output: { retryable: false },
    });

    expect(result).toEqual({
      valid: true,
      next: {
        ...step,
        status: "terminal_failed",
        output: { retryable: false },
        error,
        completedAt: "2026-07-27T02:00:00.000Z",
        updatedAt: "2026-07-27T02:00:00.000Z",
      },
    });
    expect(step.status).toBe("running");
  });

  it.each([
    ["succeeded", "running"],
    ["terminal_failed", "running"],
    ["compensated", "running"],
    ["skipped", "running"],
    ["pending", "succeeded"],
  ] satisfies [StepStatus, StepStatus][])("rejects %s -> %s", (from, to) => {
    const result = transitionStep(createStep(from), to);

    expect(result).toEqual({
      valid: false,
      reason: `invalid step transition: ${from} -> ${to}`,
    });
  });
});
