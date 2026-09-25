import { describe, expect, it, vi } from "vitest";

import {
  BoundedToolDispatchScheduler,
  ToolSchedulingError,
  type ConcurrencyClassification,
} from "./scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createScheduler(maxConcurrentReads = 2, maxConcurrentReadsPerRun = 1) {
  return new BoundedToolDispatchScheduler({
    maxConcurrentReads,
    maxConcurrentReadsPerRun,
  });
}

describe("BoundedToolDispatchScheduler", () => {
  it("serializes mutation and unknown dispatches", async () => {
    const scheduler = createScheduler();
    const firstGate = deferred<void>();
    const first = vi.fn(async () => {
      await firstGate.promise;
      return "first";
    });
    const second = vi.fn(async () => "second");

    const firstResult = scheduler.schedule("serial", first);
    const secondResult = scheduler.schedule(
      "unknown" as ConcurrencyClassification,
      second
    );
    await flushPromises();

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    firstGate.resolve();
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
  });

  it("runs safe reads concurrently within the process limit", async () => {
    const scheduler = createScheduler(2, 1);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let maxActive = 0;
    const operations = gates.map((gate, index) =>
      scheduler.schedule(
        "concurrent_safe",
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate.promise;
          active -= 1;
          return index;
        },
        { runId: `run-${index}` }
      )
    );
    await flushPromises();

    expect(maxActive).toBe(2);
    gates[0].resolve();
    await operations[0];
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(operations);
    expect(maxActive).toBe(2);
  });

  it("defers when one Run reaches its capacity without blocking another Run", async () => {
    const scheduler = createScheduler(2, 1);
    const firstGate = deferred<void>();
    const first = scheduler.schedule(
      "concurrent_safe",
      async () => {
        await firstGate.promise;
        return "first";
      },
      { runId: "run-a" }
    );
    const rejectedOperation = vi.fn(async () => "unexpected");

    await expect(
      scheduler.schedule("concurrent_safe", rejectedOperation, {
        runId: "run-a",
      })
    ).rejects.toMatchObject({ code: "TOOL_RUN_CAPACITY_EXCEEDED" });
    await expect(
      scheduler.schedule("concurrent_safe", async () => "other", {
        runId: "run-b",
      })
    ).resolves.toBe("other");
    expect(rejectedOperation).not.toHaveBeenCalled();

    firstGate.resolve();
    await first;
  });

  it("removes the per-Run entry when its active work reaches zero", async () => {
    const scheduler = createScheduler();

    await scheduler.schedule("concurrent_safe", async () => "done", {
      runId: "run-a",
    });

    expect(scheduler.getTrackedRunCount()).toBe(0);
  });

  it("aborts and removes a queued read waiter", async () => {
    const scheduler = createScheduler(1, 1);
    const firstGate = deferred<void>();
    const first = scheduler.schedule(
      "concurrent_safe",
      async () => {
        await firstGate.promise;
      },
      { runId: "run-a" }
    );
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => "queued");
    const queued = scheduler.schedule("concurrent_safe", queuedOperation, {
      runId: "run-b",
      signal: controller.signal,
    });
    await flushPromises();

    controller.abort();

    await expect(queued).rejects.toMatchObject({ code: "USER_CANCELLED" });
    expect(queuedOperation).not.toHaveBeenCalled();
    firstGate.resolve();
    await first;
    await expect(
      scheduler.schedule("concurrent_safe", async () => "next", {
        runId: "run-c",
      })
    ).resolves.toBe("next");
  });

  it("aborts a serial tail waiter without running its operation", async () => {
    const scheduler = createScheduler();
    const firstGate = deferred<void>();
    const first = scheduler.schedule("serial", async () => {
      await firstGate.promise;
    });
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => "queued");
    const queued = scheduler.schedule("serial", queuedOperation, {
      signal: controller.signal,
    });
    await flushPromises();

    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(ToolSchedulingError);
    expect(queuedOperation).not.toHaveBeenCalled();
    firstGate.resolve();
    await first;
    await expect(scheduler.schedule("serial", async () => "next")).resolves.toBe(
      "next"
    );
  });

  it("releases a serial slot after an operation rejects", async () => {
    const scheduler = createScheduler();

    await expect(
      scheduler.schedule("serial", async () => {
        throw new Error("expected failure");
      })
    ).rejects.toThrow("expected failure");
    await expect(
      scheduler.schedule("serial", async () => "recovered")
    ).resolves.toBe("recovered");
  });
});
