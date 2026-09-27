import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "./execution-context/execution-context.js";
import { emitEnvelope } from "./emit-envelope.js";
import { RunSequenceAllocator } from "./event-sequence.js";
import type { EventRepository } from "./persistence/event-repository.js";
import type { TaskEvent } from "./types.js";

const executionContext: ExecutionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user",
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "trusted_gateway",
    authenticatedAt: "2026-09-27T00:00:00.000Z",
  },
  scope: {
    scopeId: "tenant-1",
    scopeType: "tenant",
    tenantId: "tenant-1",
  },
};

const legacyEvent: TaskEvent = {
  eventId: "legacy-event-1",
  taskId: "task-1",
  eventType: "task_created",
  payload: { task: { taskId: "task-1", status: "created" } },
  createdAt: "2026-09-27T00:00:00.000Z",
};

function createRepository(append: EventRepository["append"]): EventRepository {
  return {
    append,
    findByTaskId: async () => [],
    async *streamByTaskId(): AsyncIterable<TaskEvent> {},
  };
}

describe("emitEnvelope", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects the complete versioned envelope contract", async () => {
    const envelope = await emitEnvelope({
      type: "task.created",
      payload: { taskId: "task-1", status: "created" },
      executionContext,
      sequenceAllocator: new RunSequenceAllocator(),
      legacyEvent,
      eventId: "event-1",
      now: () => new Date("2026-09-27T01:00:00.000Z"),
    });

    expect(envelope).toEqual({
      schemaVersion: "1.0.0",
      eventId: "event-1",
      sequence: 1,
      type: "task.created",
      emittedAt: "2026-09-27T01:00:00.000Z",
      context: expect.objectContaining({ runId: "run-1", taskId: "task-1" }),
      payload: { taskId: "task-1", status: "created" },
    });
  });

  it("persists replay identity before resolving a required event", async () => {
    let persisted = false;
    const append = vi.fn<EventRepository["append"]>(async (event) => {
      persisted = true;
      return event;
    });

    const envelope = await emitEnvelope({
      type: "run.terminal",
      payload: { status: "completed", reasonCode: "RUN_COMPLETED" },
      executionContext,
      sequenceAllocator: new RunSequenceAllocator(),
      legacyEvent,
      eventId: "terminal-event-1",
      eventRepository: createRepository(append),
    });

    expect(persisted).toBe(true);
    expect(envelope).toEqual(expect.objectContaining({ eventId: "terminal-event-1" }));
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "terminal-event-1",
        payload: expect.objectContaining({
          runtimeEventIdentity: expect.objectContaining({ sequence: 1 }),
        }),
      })
    );
  });

  it("fails closed when required identity persistence fails", async () => {
    const repository = createRepository(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      emitEnvelope({
        type: "run.terminal",
        payload: { status: "crashed", reasonCode: "PROCESS_CRASHED" },
        executionContext,
        sequenceAllocator: new RunSequenceAllocator(),
        legacyEvent,
        eventRepository: repository,
      })
    ).rejects.toThrow("database unavailable");
  });

  it("returns the original legacy event without persistence when disabled", async () => {
    const append = vi.fn<EventRepository["append"]>(async (event) => event);
    const allocator = new RunSequenceAllocator();

    const result = await emitEnvelope({
      type: "task.created",
      payload: { taskId: "task-1", status: "created" },
      executionContext,
      sequenceAllocator: allocator,
      legacyEvent,
      runtimeEventEnvelopeEnabled: false,
      persistencePolicy: "required",
      eventRepository: createRepository(append),
    });

    expect(result).toBe(legacyEvent);
    expect(result).toEqual(legacyEvent);
    expect(append).not.toHaveBeenCalled();
    expect(allocator.size).toBe(0);
  });
});
