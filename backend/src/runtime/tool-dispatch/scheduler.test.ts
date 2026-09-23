import { describe, expect, it, vi } from "vitest";

import { BoundedToolDispatchScheduler } from "./scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BoundedToolDispatchScheduler", () => {
  it("serializes mutation and unknown dispatches", async () => {
    const scheduler = new BoundedToolDispatchScheduler(2);
    const firstGate = deferred<void>();
    const first = vi.fn(async () => {
      await firstGate.promise;
      return "first";
    });
    const second = vi.fn(async () => "second");

    const firstResult = scheduler.schedule(false, first);
    const secondResult = scheduler.schedule(false, second);
    await Promise.resolve();

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    firstGate.resolve();
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
  });

  it("bounds concurrency for explicitly safe read-only dispatches", async () => {
    const scheduler = new BoundedToolDispatchScheduler(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let maxActive = 0;
    const operations = gates.map((gate, index) =>
      scheduler.schedule(true, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
        return index;
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(maxActive).toBe(2);
    gates[0].resolve();
    await operations[0];
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(operations);
    expect(maxActive).toBe(2);
  });

  it("releases a serial slot after an operation rejects", async () => {
    const scheduler = new BoundedToolDispatchScheduler(1);

    await expect(
      scheduler.schedule(false, async () => {
        throw new Error("expected failure");
      })
    ).rejects.toThrow("expected failure");
    await expect(
      scheduler.schedule(false, async () => "recovered")
    ).resolves.toBe("recovered");
  });
});
