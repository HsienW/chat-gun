import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCheckpointFixture } from "./checkpoint-fixture.testing.js";
import { createAdapterCheckpointBoundary } from "./adapter-checkpoint-boundary.js";

function fixture(adapterId: string) {
  const { metadata, policy } = createCheckpointFixture(adapterId);
  let stored: unknown = { metadata, state: { cursor: 1 } };
  const read = vi.fn(async () => stored);
  const append = vi.fn(async () => {});
  const boundary = createAdapterCheckpointBoundary({
    store: { read, append },
    stateSchema: z.object({ cursor: z.number().int().nonnegative(), value: z.unknown().optional() }).strict(),
    containsSecret: (serialized) => serialized.includes("fixture-credential"),
    maxBytes: 4096,
    maxDepth: 16,
  });
  return { metadata, policy, boundary, read, append, replace: (value: unknown) => { stored = value; } };
}

afterEach(() => vi.useRealTimers());

describe.each(["langgraph", "reference"])("%s checkpoint boundary", (adapterId) => {
  it("reads declared state without exposing store-owned opaque objects", async () => {
    const { boundary, policy } = fixture(adapterId);
    expect(await boundary.read(policy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: 1 } } });
  });

  it("parks a deployment version change without writing or losing the old checkpoint", async () => {
    const { boundary, policy, append } = fixture(adapterId);
    expect(await boundary.read({ ...policy, supportedAdapters: [] }, { timeoutMs: 1000 })).toMatchObject({ status: "parked", compatibility: { action: "park" } });
    expect(append).not.toHaveBeenCalled();
    expect(await boundary.read(policy, { timeoutMs: 1000 })).toMatchObject({ status: "ready" });
  });

  it.each([() => {}, new Date(), new AbortController(), BigInt(1), undefined, NaN,
    { password: "not-persistable" }, "fixture-credential",
  ])("rejects unsafe state before storage: %s", async (value) => {
    const { boundary, policy, metadata, append } = fixture(adapterId);
    await expect(boundary.append({ metadata, state: { cursor: 2, value } }, policy, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "CHECKPOINT_STATE_INVALID" });
    expect(append).not.toHaveBeenCalled();
    expect(await boundary.read(policy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: 1 } } });
  });

  it("rejects unknown fields, cycles, accessors, oversized and silently transformed state", async () => {
    const { boundary, policy, metadata, append } = fixture(adapterId);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = vi.fn(() => "data");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    for (const state of [{ cursor: 1, extra: true }, { cursor: 1, value: cycle }, { cursor: 1, value: accessor }, { cursor: 1, value: "x".repeat(4096) }]) {
      await expect(boundary.append({ metadata, state }, policy, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "CHECKPOINT_STATE_INVALID" });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("requires a new checkpoint reference for append and preserves its parent", async () => {
    const { boundary, policy, metadata, append } = fixture(adapterId);
    await expect(boundary.append({ metadata, state: { cursor: 2 } }, policy, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "CHECKPOINT_STATE_INVALID" });
    const next = { ...metadata, nativeCheckpointRef: { ...metadata.nativeCheckpointRef, checkpointId: "checkpoint-2" } };
    expect(await boundary.append({ metadata: next, state: { cursor: 2 } }, policy, { timeoutMs: 1000 })).toEqual({ status: "saved", checkpoint: { metadata: next, state: { cursor: 2 } } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ parent: metadata.nativeCheckpointRef }), expect.any(AbortSignal));
    expect(await boundary.read(policy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: 1 } } });
  });

  it.each(["timeout", "cancel"])("reports uncertain persistence after store %s, never safe replay", async (mode) => {
    vi.useFakeTimers();
    const { boundary, policy, metadata, append } = fixture(adapterId);
    append.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const next = { ...metadata, nativeCheckpointRef: { ...metadata.nativeCheckpointRef, checkpointId: "checkpoint-2" } };
    const pending = boundary.append({ metadata: next, state: { cursor: 2 } }, policy, { timeoutMs: 10, signal: controller.signal });
    await Promise.resolve();
    if (mode === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ status: "indeterminate", action: "reconcile", reasonCode: mode === "cancel" ? "ADAPTER_OPERATION_CANCELLED" : "ADAPTER_OPERATION_TIMEOUT" });
    expect(await boundary.read(policy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: 1 } } });
  });
});
