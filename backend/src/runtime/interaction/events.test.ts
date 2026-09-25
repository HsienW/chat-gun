import { describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "../../platform/observability.js";
import { createNoopSpanManager } from "../../platform/tracing/span-manager.js";
import type { EventRepository } from "../persistence/event-repository.js";
import type { TaskEvent } from "../types.js";
import {
  InteractionEventRecorder,
  createClarificationInterruptId,
  createInteractionInputReference,
  createInteractionTaskEvent,
  createTentativeClassificationTaskEvents,
  type InteractionTaskEventType,
} from "./events.js";

const rawInput = "private@example.test Bearer credential-value";
const encodedInput = new TextEncoder().encode(rawInput);

const interactionEventTypes = [
  "queued",
  "cancelling",
  "cancelled",
  "superseded",
  "rollback_requested",
  "cancelled_after_commit",
  "manual_intervention_required",
  "clarification_requested",
  "clarification_resumed",
] as const satisfies readonly InteractionTaskEventType[];

function createEvent(eventType: InteractionTaskEventType) {
  return createInteractionTaskEvent(
    {
      eventType,
      threadId: "thread-1",
      priorTaskId: "task-1",
      priorRunId: "run-1",
      replacementTaskId: "task-2",
      replacementRunId: "run-2",
      generation: 2,
      input: createInteractionInputReference(encodedInput, "intent_revision"),
      sideEffectState: "read_only",
      compensationResult: null,
      reconciliationResult: null,
    },
    {
      createEventId: () => `event-${eventType}`,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    }
  );
}

describe("interaction task events", () => {
  it("creates a stable opaque clarification interrupt id", () => {
    const first = createClarificationInterruptId({
      threadId: "thread-1",
      runId: "run-1",
      checkpointStep: 7,
    });
    const repeated = createClarificationInterruptId({
      threadId: "thread-1",
      runId: "run-1",
      checkpointStep: 7,
    });
    const next = createClarificationInterruptId({
      threadId: "thread-1",
      runId: "run-1",
      checkpointStep: 8,
    });

    expect(first).toMatch(/^clarification:[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(next).not.toBe(first);
  });

  it("preserves interrupt identity on clarification events", () => {
    const event = createInteractionTaskEvent({
      eventType: "clarification_requested",
      threadId: "thread-1",
      priorTaskId: "task-1",
      priorRunId: "run-1",
      replacementTaskId: null,
      replacementRunId: null,
      generation: 1,
      interruptId: "clarification:" + "a".repeat(64),
      input: createInteractionInputReference(encodedInput),
      sideEffectState: "read_only",
      compensationResult: null,
      reconciliationResult: null,
    });

    expect(event.payload.interruptId).toBe(
      "clarification:" + "a".repeat(64),
    );
  });

  it.each(interactionEventTypes)("creates correlated %s events", (eventType) => {
    expect(createEvent(eventType)).toEqual({
      eventId: `event-${eventType}`,
      taskId: "task-1",
      eventType,
      createdAt: "2026-08-20T00:00:00.000Z",
      payload: {
        schemaVersion: "1.0",
        threadId: "thread-1",
        priorTaskId: "task-1",
        priorRunId: "run-1",
        replacementTaskId: "task-2",
        replacementRunId: "run-2",
        generation: 2,
        input: {
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          byteLength: encodedInput.byteLength,
          classification: "intent_revision",
        },
        sideEffectState: "read_only",
        compensationResult: null,
        reconciliationResult: null,
      },
    });
  });

  it("emits tentative classification and input confirmation waiting events", () => {
    const events = createTentativeClassificationTaskEvents(
      {
        threadId: "thread-1",
        priorTaskId: "task-1",
        priorRunId: "run-1",
        generation: 3,
        input: createInteractionInputReference(
          new TextEncoder().encode("sensitive classification input"),
          "intent_revision"
        ),
        classificationReasonCode: "SEMANTIC_RELATIONSHIP_SUGGESTED",
        classifierVersion: "semantic-classifier-v1",
      },
      {
        createEventId: vi
          .fn<() => string>()
          .mockReturnValueOnce("event-tentative")
          .mockReturnValueOnce("event-waiting"),
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      }
    );

    expect(events).toEqual([
      expect.objectContaining({
        eventId: "event-tentative",
        eventType: "input_classification_tentative",
        payload: expect.objectContaining({
          classifierVersion: "semantic-classifier-v1",
          classificationReasonCode: "SEMANTIC_RELATIONSHIP_SUGGESTED",
          generation: 3,
        }),
      }),
      expect.objectContaining({
        eventId: "event-waiting",
        eventType: "waiting_confirmation",
        payload: expect.objectContaining({
          confirmationType: "input_classification",
          generation: 3,
        }),
      }),
    ]);
  });

  it("writes task event, audit and OTel attributes without raw input or metric labels", async () => {
    const append = vi.fn<EventRepository["append"]>(async (event) => event);
    const auditRecord = vi.fn<AuditLogger["record"]>(async () => undefined);
    const spanManager = createNoopSpanManager();
    const activeSpan = spanManager.startSpan("test");
    vi.spyOn(spanManager, "getActiveSpan").mockReturnValue(activeSpan);
    const setAttributes = vi.spyOn(spanManager, "setAttributes");
    const recorder = new InteractionEventRecorder(
      {
        append,
        findByTaskId: async () => [],
        async *streamByTaskId(): AsyncIterable<TaskEvent> {},
      },
      { record: auditRecord },
      spanManager
    );

    const event = createEvent("superseded");
    await recorder.record(event);

    expect(append).toHaveBeenCalledWith(event);
    expect(auditRecord).toHaveBeenCalledWith(
      "interaction.superseded",
      expect.objectContaining({
        threadId: "thread-1",
        taskId: "task-1",
        runId: "run-1",
        replacementRunId: "run-2",
        generation: 2,
        reasonCode: "INTERACTION_SUPERSEDED",
      })
    );
    expect(setAttributes).toHaveBeenCalledWith(
      activeSpan,
      expect.objectContaining({
        "interaction.thread_id": "thread-1",
        "interaction.task_id": "task-1",
        "interaction.run_id": "run-1",
        "interaction.generation": 2,
      })
    );

    const recorded = JSON.stringify({
      event: append.mock.calls[0]?.[0],
      audit: auditRecord.mock.calls[0]?.[1],
      trace: setAttributes.mock.calls[0]?.[1],
    });
    expect(recorded).not.toContain(rawInput);
    expect(recorded).not.toContain("credential-value");
    expect(recorded).not.toContain("metric");
  });
});
