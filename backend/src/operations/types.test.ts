import { describe, expect, it } from "vitest";

import {
  parseCheckpointedExecutionBudget,
  parseExecutionBudget,
  parseExecutionManifest,
  parseTaskGoal,
  parseWorkerRecoveryClassification,
  parseWorkerRecoveryDecision,
} from "./types.js";

const timestamp = "2026-09-14T00:00:00.000Z";

describe("operations runtime types", () => {
  it("parses a TaskGoal with a closed lifecycle status", () => {
    expect(
      parseTaskGoal({
        goalId: "goal-1",
        taskId: "task-1",
        objective: "Complete the bounded operations task",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    ).toMatchObject({ goalId: "goal-1", status: "active" });

    expect(() =>
      parseTaskGoal({
        goalId: "goal-1",
        taskId: "task-1",
        objective: "Unknown status",
        status: "future_status",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    ).toThrow();
  });

  it("requires finite non-negative whole-goal budget limits", () => {
    expect(
      parseExecutionBudget({
        maxTurns: 3,
        maxTokens: 1_000,
        maxElapsedMs: 60_000,
        maxModelCalls: 2,
        maxToolCalls: 2,
        maxCostUsd: 1.25,
      })
    ).toEqual({
      maxTurns: 3,
      maxTokens: 1_000,
      maxElapsedMs: 60_000,
      maxModelCalls: 2,
      maxToolCalls: 2,
      maxCostUsd: 1.25,
    });

    expect(() =>
      parseExecutionBudget({ maxTurns: 1, maxTokens: 10 })
    ).toThrow();
    expect(() =>
      parseExecutionBudget({ maxTurns: -1, maxTokens: 10, maxElapsedMs: 5 })
    ).toThrow();
    expect(() =>
      parseExecutionBudget({ maxTurns: 1, maxTokens: Number.POSITIVE_INFINITY, maxElapsedMs: 5 })
    ).toThrow();
  });

  it("rejects unknown fields at the manifest boundary and treats omitted optional versions as not applicable", () => {
    const manifest = {
      runtimeBuildId: "build-1",
      graphVersion: "graph-1",
      promptVersion: "prompt-1",
      modelRouteVersion: "route-1",
      toolSchemaVersion: "tool-1",
      policyVersion: "policy-1",
    };

    expect(parseExecutionManifest(manifest)).toEqual(manifest);
    expect(() => parseExecutionManifest({ ...manifest, unknownVersion: "v1" })).toThrow();
  });

  it("validates JSON-serializable checkpointed budget counters", () => {
    const checkpoint = parseCheckpointedExecutionBudget({
      schemaVersion: "1",
      goalId: "goal-1",
      policyVersion: "policy-1",
      limits: { maxTurns: 2, maxTokens: 100, maxElapsedMs: 1_000 },
      usage: {
        turns: 1,
        tokens: 50,
        activeElapsedMs: 250,
        modelCalls: 1,
        toolCalls: 0,
        costUsd: 0.01,
      },
      exhaustedDimensions: [],
      updatedAt: timestamp,
    });

    expect(JSON.parse(JSON.stringify(checkpoint))).toEqual(checkpoint);
    expect(() =>
      parseCheckpointedExecutionBudget({
        ...checkpoint,
        usage: { ...checkpoint.usage, toolCalls: Number.NaN },
      })
    ).toThrow();
  });

  it("fails closed for unknown recovery classifications and decisions", () => {
    expect(parseWorkerRecoveryClassification("requeue_safe")).toBe("requeue_safe");
    expect(parseWorkerRecoveryDecision("reconciliation_required")).toBe(
      "reconciliation_required"
    );
    expect(() => parseWorkerRecoveryClassification("retry_anyway")).toThrow();
    expect(() => parseWorkerRecoveryDecision("ignored")).toThrow();
  });
});
