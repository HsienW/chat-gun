import { describe, expect, it } from "vitest";

import {
  applyExecutionBudgetUsage,
  createCheckpointedExecutionBudget,
  getExecutionBudgetDecision,
  restoreCheckpointedExecutionBudget,
} from "./execution-budget.js";

const INITIAL_AT = "2026-09-14T00:00:00.000Z";
const UPDATED_AT = "2026-09-14T00:01:00.000Z";

describe("ExecutionBudget accounting", () => {
  it("accumulates successful and failed turns across the whole goal", () => {
    const initial = createCheckpointedExecutionBudget({
      goalId: "goal-1",
      policyVersion: "budget-v1",
      limits: { maxTurns: 3, maxTokens: 100, maxElapsedMs: 1_000 },
      updatedAt: INITIAL_AT,
    });

    const afterSuccessfulTurn = applyExecutionBudgetUsage(initial, {
      usageDelta: {
        turns: 1,
        tokens: 25,
        activeElapsedMs: 100,
        modelCalls: 1,
      },
      updatedAt: UPDATED_AT,
    });
    const afterFailedTurn = applyExecutionBudgetUsage(afterSuccessfulTurn, {
      usageDelta: {
        turns: 1,
        tokens: 15,
        activeElapsedMs: 50,
        modelCalls: 1,
      },
      updatedAt: "2026-09-14T00:02:00.000Z",
    });

    expect(afterFailedTurn.usage).toEqual({
      turns: 2,
      tokens: 40,
      activeElapsedMs: 150,
      modelCalls: 2,
      toolCalls: 0,
      costUsd: 0,
    });
    expect(afterFailedTurn.exhaustedDimensions).toEqual([]);
  });

  it("returns budget_exhausted when any configured dimension reaches its limit", () => {
    const initial = createCheckpointedExecutionBudget({
      goalId: "goal-2",
      policyVersion: "budget-v1",
      limits: {
        maxTurns: 2,
        maxTokens: 100,
        maxElapsedMs: 1_000,
        maxModelCalls: 2,
      },
      updatedAt: INITIAL_AT,
    });
    const exhausted = applyExecutionBudgetUsage(initial, {
      usageDelta: { turns: 2, tokens: 40, modelCalls: 2 },
      updatedAt: UPDATED_AT,
    });

    expect(exhausted.exhaustedDimensions).toEqual([
      "turns",
      "model_calls",
    ]);
    expect(getExecutionBudgetDecision(exhausted)).toEqual({
      status: "budget_exhausted",
      exhaustedDimensions: ["turns", "model_calls"],
      isSuccess: false,
      authorizesUnsafeReplay: false,
    });
  });

  it("restores monotonic counters from a serialized checkpoint", () => {
    const checkpoint = applyExecutionBudgetUsage(
      createCheckpointedExecutionBudget({
        goalId: "goal-3",
        policyVersion: "budget-v2",
        limits: { maxTurns: 5, maxTokens: 500, maxElapsedMs: 5_000 },
        updatedAt: INITIAL_AT,
      }),
      {
        usageDelta: { turns: 1, tokens: 80, activeElapsedMs: 250 },
        updatedAt: UPDATED_AT,
      }
    );

    const restored = restoreCheckpointedExecutionBudget(
      JSON.parse(JSON.stringify(checkpoint)),
      { goalId: "goal-3", policyVersion: "budget-v2" }
    );

    expect(restored).toEqual(checkpoint);
    expect(() =>
      restoreCheckpointedExecutionBudget(checkpoint, {
        goalId: "other-goal",
        policyVersion: "budget-v2",
      })
    ).toThrow("EXECUTION_BUDGET_GOAL_MISMATCH");
  });

  it("rejects negative or unknown usage delta fields", () => {
    const initial = createCheckpointedExecutionBudget({
      goalId: "goal-4",
      policyVersion: "budget-v1",
      limits: { maxTurns: 2, maxTokens: 100, maxElapsedMs: 1_000 },
      updatedAt: INITIAL_AT,
    });

    expect(() =>
      applyExecutionBudgetUsage(initial, {
        usageDelta: { tokens: -1 },
        updatedAt: UPDATED_AT,
      })
    ).toThrow();
    expect(() =>
      applyExecutionBudgetUsage(initial, {
        usageDelta: { unknown: 1 } as never,
        updatedAt: UPDATED_AT,
      })
    ).toThrow();
  });
});
