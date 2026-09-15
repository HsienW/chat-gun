import { describe, expect, it } from "vitest";

import {
  createTaskGoal,
  pauseTaskGoal,
  resumeTaskGoal,
  settleTaskGoal,
  toTaskGoalOperationsView,
} from "./task-goal.js";

const CREATED_AT = "2026-09-14T00:00:00.000Z";
const PAUSED_AT = "2026-09-14T00:01:00.000Z";
const RESUMED_AT = "2026-09-14T00:02:00.000Z";

describe("TaskGoal lifecycle", () => {
  it("preserves goal identity across pause and resume", () => {
    const goal = createTaskGoal({
      goalId: "goal-1",
      taskId: "task-1",
      objective: "Produce a verified artifact",
      createdAt: CREATED_AT,
    });

    const paused = pauseTaskGoal(goal, {
      updatedAt: PAUSED_AT,
      progressSummary: "Waiting for approval",
    });
    const resumed = resumeTaskGoal(paused, {
      updatedAt: RESUMED_AT,
      isBusinessIntentUnchanged: true,
    });

    expect(paused).toMatchObject({ goalId: "goal-1", status: "paused" });
    expect(resumed).toMatchObject({
      goalId: "goal-1",
      status: "active",
      createdAt: CREATED_AT,
      updatedAt: RESUMED_AT,
    });
  });

  it("completes only when the explicit completion gate passes", () => {
    const goal = createTaskGoal({
      goalId: "goal-2",
      taskId: "task-2",
      objective: "Pass deterministic checks",
      createdAt: CREATED_AT,
    });

    expect(
      settleTaskGoal(goal, {
        updatedAt: PAUSED_AT,
        completionGateStatus: "failed",
        isBudgetExhausted: false,
      }).status
    ).toBe("active");
    expect(
      settleTaskGoal(goal, {
        updatedAt: RESUMED_AT,
        completionGateStatus: "passed",
        isBudgetExhausted: false,
      }).status
    ).toBe("completed");
  });

  it("reports budget exhaustion as non-success in operations output", () => {
    const goal = createTaskGoal({
      goalId: "goal-3",
      taskId: "task-3",
      objective: "Stay within whole-goal budget",
      createdAt: CREATED_AT,
    });

    const exhausted = settleTaskGoal(goal, {
      updatedAt: PAUSED_AT,
      completionGateStatus: "failed",
      isBudgetExhausted: true,
      progressSummary: "Token budget exhausted",
    });

    expect(exhausted.status).toBe("budget_exhausted");
    expect(toTaskGoalOperationsView(exhausted)).toEqual({
      goalId: "goal-3",
      taskId: "task-3",
      status: "budget_exhausted",
      progressSummary: "Token budget exhausted",
      updatedAt: PAUSED_AT,
    });
  });

  it("rejects resume when business intent changed", () => {
    const goal = pauseTaskGoal(
      createTaskGoal({
        goalId: "goal-4",
        taskId: "task-4",
        objective: "Original objective",
        createdAt: CREATED_AT,
      }),
      { updatedAt: PAUSED_AT }
    );

    expect(() =>
      resumeTaskGoal(goal, {
        updatedAt: RESUMED_AT,
        isBusinessIntentUnchanged: false,
      })
    ).toThrow("TASK_GOAL_INTENT_CHANGED");
  });
});
