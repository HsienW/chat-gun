import { describe, expect, it, vi } from "vitest";

import {
  drainRuntime,
  type DrainDependencies,
  type DrainWork,
} from "./drain.js";

function createWork(overrides: Partial<DrainWork> = {}): DrainWork {
  return {
    taskId: "task-1",
    runId: "run-1",
    isReplaySafe: true,
    sideEffectState: "not_started",
    ...overrides,
  };
}

function createDependencies(
  work: DrainWork[],
  overrides: Partial<DrainDependencies> = {}
): DrainDependencies {
  return {
    stopNewClaims: vi.fn(async () => undefined),
    listInFlight: vi.fn(async () => work),
    settleSafeWork: vi.fn(async () => "completed" as const),
    reconcileAmbiguousEffect: vi.fn(async () => "reconciled" as const),
    persistRecoverableState: vi.fn(async () => true),
    parkManual: vi.fn(async () => true),
    ...overrides,
  };
}

describe("graceful runtime drain", () => {
  it("stops new claims before completing safe in-flight work", async () => {
    const callOrder: string[] = [];
    const dependencies = createDependencies([createWork()], {
      stopNewClaims: async () => {
        callOrder.push("stop");
      },
      listInFlight: async () => {
        callOrder.push("list");
        return [createWork()];
      },
      settleSafeWork: async () => {
        callOrder.push("settle");
        return "completed";
      },
    });

    const result = await drainRuntime(
      { timeoutMs: 1_000 },
      dependencies
    );

    expect(callOrder).toEqual(["stop", "list", "settle"]);
    expect(result).toMatchObject({
      status: "drained",
      canShutdown: true,
      completedRunIds: ["run-1"],
    });
  });

  it("reconciles ambiguous effects before settling work", async () => {
    const callOrder: string[] = [];
    const dependencies = createDependencies(
      [createWork({ sideEffectState: "unknown" })],
      {
        reconcileAmbiguousEffect: async () => {
          callOrder.push("reconcile");
          return "reconciled";
        },
        settleSafeWork: async () => {
          callOrder.push("settle");
          return "checkpointed";
        },
      }
    );

    const result = await drainRuntime(
      { timeoutMs: 1_000 },
      dependencies
    );

    expect(callOrder).toEqual(["reconcile", "settle"]);
    expect(result).toMatchObject({
      status: "drained_with_recovery",
      canShutdown: true,
      checkpointedRunIds: ["run-1"],
    });
  });

  it("persists recoverable state when bounded drain times out", async () => {
    const dependencies = createDependencies([createWork()], {
      settleSafeWork: async (_work, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve("pending"),
            { once: true }
          );
        }),
    });

    const result = await drainRuntime({ timeoutMs: 5 }, dependencies);

    expect(dependencies.persistRecoverableState).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "drained_with_recovery",
      canShutdown: true,
      checkpointedRunIds: ["run-1"],
    });
  });

  it("does not report shutdown success while an unsafe effect is unclassified", async () => {
    const dependencies = createDependencies(
      [
        createWork({
          isReplaySafe: false,
          sideEffectState: "unknown",
        }),
      ],
      {
        reconcileAmbiguousEffect: async () => "unknown",
        parkManual: async () => false,
      }
    );

    const result = await drainRuntime(
      { timeoutMs: 1_000 },
      dependencies
    );

    expect(dependencies.settleSafeWork).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "blocked",
      canShutdown: false,
      unresolvedRunIds: ["run-1"],
    });
  });
});
