import { describe, expect, it, vi } from "vitest";

import { RunSequenceAllocator, stableEventId } from "./event-sequence.js";

describe("RunSequenceAllocator", () => {
  it("increments within one run and isolates parallel runs", () => {
    const allocator = new RunSequenceAllocator();

    expect(allocator.next("run-a")).toBe(1);
    expect(allocator.next("run-b")).toBe(1);
    expect(allocator.next("run-a")).toBe(2);
    expect(allocator.next("run-b")).toBe(2);
  });

  it("seeds a resumed run from its persisted sequence watermark", () => {
    const allocator = new RunSequenceAllocator();

    allocator.seed("run-a", 41);

    expect(allocator.next("run-a")).toBe(42);
    expect(() => allocator.seed("run-a", 1)).toThrow(/below current/i);
  });

  it("releases terminal runs and reclaims expired entries", () => {
    let currentTime = 1_000;
    const allocator = new RunSequenceAllocator({
      ttlMs: 100,
      now: () => currentTime,
    });
    allocator.next("terminal-run");
    allocator.next("leaked-run");

    expect(allocator.release("terminal-run")).toBe(true);
    currentTime = 1_101;
    expect(allocator.sweepExpired()).toBe(1);
    expect(allocator.size).toBe(0);
  });

  it("evicts the least recently used entry at the configured bound", () => {
    let currentTime = 1;
    const allocator = new RunSequenceAllocator({
      maxEntries: 2,
      now: () => currentTime++,
    });
    allocator.next("run-a");
    allocator.next("run-b");
    allocator.next("run-c");

    expect(allocator.size).toBe(2);
    expect(allocator.next("run-a")).toBe(1);
  });
});

describe("stableEventId", () => {
  it("preserves a persisted identity during replay", () => {
    const createEventId = vi.fn(() => "new-id");

    expect(stableEventId("persisted-id", createEventId)).toBe("persisted-id");
    expect(createEventId).not.toHaveBeenCalled();
  });

  it("uses the injected event identity source for a new event", () => {
    expect(stableEventId(undefined, () => "event-1")).toBe("event-1");
  });
});
