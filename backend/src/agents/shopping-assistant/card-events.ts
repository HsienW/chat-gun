import type { ExecutionContext } from "../../runtime/execution-context/execution-context.js";
import {
  projectExecutionEventContext,
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from "../../runtime/event-envelope.js";
import {
  parseRuntimeEventPayload,
  type JsonValue,
  type RuntimeEventPayload,
} from "../../runtime/event-payloads.js";
import type { RuntimeEventCursor } from "./state.js";

export interface CardEmission {
  cardType: string;
  /** Carries its own schemaVersion; ids and enums only, never free text from notes. */
  data: JsonValue;
}

export interface EmittedCards {
  runtimeEvents: RuntimeEventEnvelope<"card.emit", RuntimeEventPayload>[];
  runtimeEventCursor: RuntimeEventCursor | null;
}

/**
 * The shopping graph is the only envelope producer of its run, so the cursor
 * is the run's sequence source: it restarts at 1 for a new run and the eventId
 * derives from run and sequence, which keeps a replayed node's events identical.
 */
export function emitCardEvents(input: {
  cursor: RuntimeEventCursor | null;
  executionContext: ExecutionContext;
  cards: readonly CardEmission[];
  now?: () => Date;
}): EmittedCards {
  const runId = input.executionContext.runId;
  let nextSequence = input.cursor?.runId === runId ? input.cursor.nextSequence : 1;
  if (input.cards.length === 0) {
    return { runtimeEvents: [], runtimeEventCursor: input.cursor };
  }
  const context = projectExecutionEventContext(input.executionContext);
  const emittedAt = (input.now ?? (() => new Date()))().toISOString();
  const runtimeEvents = input.cards.map((card) => {
    const sequence = nextSequence;
    nextSequence += 1;
    const envelope: RuntimeEventEnvelope<"card.emit", RuntimeEventPayload> = {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: `${runId}:card:${sequence}`,
      sequence,
      type: "card.emit",
      emittedAt,
      context,
      payload: parseRuntimeEventPayload("card.emit", { cardType: card.cardType, data: card.data }),
    };
    runtimeEventEnvelopeSchema.parse(envelope);
    return envelope;
  });
  return { runtimeEvents, runtimeEventCursor: { runId, nextSequence } };
}
