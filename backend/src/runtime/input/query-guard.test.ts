import { describe, expect, it } from "vitest";

import {
  ActiveRunOwnershipConflictError,
  type ActiveRunOwnership,
  type ActiveRunOwnershipRepository,
} from "../interaction/ownership.js";
import { GenerationQueryGuard } from "./query-guard.js";

const now = "2026-09-26T00:00:00.000Z";

class FakeOwnershipRepository implements ActiveRunOwnershipRepository {
  active: ActiveRunOwnership | null = null;
  claimCount = 0;
  blockFirstClaim: Promise<void> | undefined;

  async findActive(): Promise<ActiveRunOwnership | null> {
    return this.active;
  }

  async claim(input: {
    threadId: string;
    scopeId: string;
    taskId: string;
    runId: string;
  }): Promise<ActiveRunOwnership> {
    this.claimCount += 1;
    if (this.blockFirstClaim) {
      const pending = this.blockFirstClaim;
      this.blockFirstClaim = undefined;
      await pending;
    }
    if (this.active) {
      throw new ActiveRunOwnershipConflictError(input.threadId, input.scopeId);
    }
    this.active = {
      ...input,
      status: "active",
      generation: 1,
      updatedAt: now,
    };
    return this.active;
  }

  async supersede(): Promise<ActiveRunOwnership> {
    throw new Error("not used");
  }

  async markTerminal(): Promise<ActiveRunOwnership | null> {
    return null;
  }
}

const firstScope = {
  threadId: "thread-1",
  scopeId: "scope-1",
  taskId: "task-1",
  runId: "run-1",
};

describe("GenerationQueryGuard", () => {
  it("advances idle to dispatching to running", async () => {
    const repository = new FakeOwnershipRepository();
    const guard = new GenerationQueryGuard(repository);

    const reservation = await guard.reserve(firstScope, 1);

    expect(reservation).toMatchObject({
      reserved: true,
      ownership: { runId: "run-1", generation: 1 },
    });
    expect(guard.read(firstScope)).toEqual({
      state: "dispatching",
      runId: "run-1",
      generation: 1,
    });

    await guard.dispatch(firstScope, 1);
    expect(guard.read(firstScope)?.state).toBe("running");
  });

  it("routes a second submit during the dispatch gap using the durable owner", async () => {
    const repository = new FakeOwnershipRepository();
    let releaseClaim!: () => void;
    repository.blockFirstClaim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const guard = new GenerationQueryGuard(repository);

    const first = guard.reserve(firstScope, 1);
    const second = guard.reserve(
      { ...firstScope, taskId: "task-2", runId: "run-2" },
      2,
    );

    releaseClaim();
    await expect(first).resolves.toMatchObject({ reserved: true });
    await expect(second).resolves.toMatchObject({
      reserved: false,
      reason: "ownership_conflict",
      ownership: { runId: "run-1", generation: 1 },
    });
    expect(repository.claimCount).toBe(1);
  });

  it("routes a second submit while running using the durable owner", async () => {
    const repository = new FakeOwnershipRepository();
    const guard = new GenerationQueryGuard(repository);
    await guard.reserve(firstScope, 1);
    await guard.dispatch(firstScope, 1);

    const second = await guard.reserve(
      { ...firstScope, taskId: "task-2", runId: "run-2" },
      2,
    );

    expect(second).toMatchObject({
      reserved: false,
      reason: "ownership_conflict",
      ownership: { runId: "run-1", generation: 1 },
    });
    expect(repository.claimCount).toBe(1);
  });

  it("uses durable CAS so two worker guards have exactly one winner", async () => {
    const repository = new FakeOwnershipRepository();
    const workerA = new GenerationQueryGuard(repository);
    const workerB = new GenerationQueryGuard(repository);

    const results = await Promise.all([
      workerA.reserve(firstScope, 1),
      workerB.reserve(
        { ...firstScope, taskId: "task-2", runId: "run-2" },
        1,
      ),
    ]);

    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.filter((result) => !result.reserved)).toHaveLength(1);
    expect(repository.active?.runId).toBe("run-1");
  });

  it("returns the authoritative active ownership without a blind second claim", async () => {
    const repository = new FakeOwnershipRepository();
    repository.active = {
      ...firstScope,
      status: "active",
      generation: 3,
      updatedAt: now,
    };
    const guard = new GenerationQueryGuard(repository);

    const result = await guard.reserve(
      { ...firstScope, taskId: "task-2", runId: "run-2" },
      4,
    );

    expect(result).toEqual({
      reserved: false,
      reason: "ownership_conflict",
      ownership: repository.active,
    });
    expect(repository.claimCount).toBe(0);
  });

  it("does not release a newer generation from a stale finalizer", async () => {
    const repository = new FakeOwnershipRepository();
    const guard = new GenerationQueryGuard(repository);
    await guard.reserve(firstScope, 1);
    await guard.dispatch(firstScope, 1);

    repository.active = {
      ...firstScope,
      taskId: "task-2",
      runId: "run-2",
      status: "active",
      generation: 2,
      updatedAt: now,
    };
    guard.adopt(repository.active, "running");

    await guard.release(firstScope, 1);
    expect(guard.read(firstScope)).toEqual({
      state: "running",
      runId: "run-2",
      generation: 2,
    });

    await guard.release({ ...firstScope, runId: "run-2" }, 2);
    expect(guard.read(firstScope)).toBeUndefined();
  });
});
