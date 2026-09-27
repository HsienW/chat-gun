import { describe, expect, it } from "vitest";

import type { ExecutionContext } from "./execution-context/execution-context.js";
import { LegacyRuntimeEventAdapter } from "./legacy-event-adapter.js";

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

describe("LegacyRuntimeEventAdapter", () => {
  it("wraps a legacy TaskEvent and preserves its eventId", async () => {
    const adapter = new LegacyRuntimeEventAdapter({ enabled: true });
    const envelope = await adapter.adapt(
      {
        eventId: "task-event-1",
        taskId: "task-1",
        eventType: "task_completed",
        createdAt: "2026-09-27T00:00:00.000Z",
      },
      executionContext
    );

    expect(envelope).toEqual(
      expect.objectContaining({
        schemaVersion: "1.0.0",
        eventId: "task-event-1",
        sequence: 1,
        type: "task.completed",
        payload: { taskId: "task-1", status: "completed" },
      })
    );
  });

  it("adapts legacy AgentRuntimeEvent and assigns arrival-order sequences", async () => {
    const adapter = new LegacyRuntimeEventAdapter({ enabled: true });

    const first = await adapter.adapt(
      { type: "agent.answer.stream", delta: "one", ts: 1 },
      executionContext
    );
    const second = await adapter.adapt(
      { type: "agent.answer.stream", delta: "two", ts: 2 },
      executionContext
    );

    expect(first).toEqual(
      expect.objectContaining({ type: "model.stream", sequence: 1, payload: { delta: "one" } })
    );
    expect(second).toEqual(
      expect.objectContaining({ type: "model.stream", sequence: 2, payload: { delta: "two" } })
    );
  });

  it("creates a stable synthetic identity from content when eventId is absent", async () => {
    const event = { type: "agent.context.build", sources: [], tokenEstimate: 0, ts: 1 };
    const firstAdapter = new LegacyRuntimeEventAdapter({ enabled: true });
    const secondAdapter = new LegacyRuntimeEventAdapter({ enabled: true });

    const first = await firstAdapter.adapt(event, executionContext);
    const replay = await secondAdapter.adapt(event, executionContext);

    expect("eventId" in first && "eventId" in replay).toBe(true);
    if (!("eventId" in first) || !("eventId" in replay)) {
      throw new Error("Expected versioned envelopes");
    }
    expect(first.eventId).toBe(replay.eventId);
  });

  it("passes an already-versioned envelope through unchanged", async () => {
    const adapter = new LegacyRuntimeEventAdapter({ enabled: true });
    const envelope = {
      schemaVersion: "1.0.0",
      eventId: "event-1",
      sequence: 1,
      type: "model.stream",
      emittedAt: "2026-09-27T00:00:00.000Z",
      context: {
        requestId: "request-1",
        threadId: "thread-1",
        runId: "run-1",
        taskId: "task-1",
        attempt: 1,
        principalId: "principal-1",
        tenantId: "tenant-1",
        scopeId: "tenant-1",
        scopeType: "tenant",
      },
      payload: { delta: "hello" },
    };

    expect(await adapter.adapt(envelope, executionContext)).toBe(envelope);
  });

  it("returns the legacy event unchanged when the rollout flag is disabled", async () => {
    const adapter = new LegacyRuntimeEventAdapter({ enabled: false });
    const legacy = { type: "agent.answer.stream", delta: "legacy", ts: 1 };

    expect(await adapter.adapt(legacy, executionContext)).toBe(legacy);
  });
});
