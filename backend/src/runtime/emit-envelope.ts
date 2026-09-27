import { getAgentRuntimeConfig } from "../platform/runtime-config.js";
import type { ExecutionContext } from "./execution-context/execution-context.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  projectExecutionEventContext,
  runtimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from "./event-envelope.js";
import {
  parseRuntimeEventPayload,
  type RuntimeEventPayload,
  type RuntimeEventType,
} from "./event-payloads.js";
import { RunSequenceAllocator, stableEventId } from "./event-sequence.js";
import type { EventRepository } from "./persistence/event-repository.js";
import { TASK_EVENT_TYPES, type TaskEvent } from "./types.js";

export type EventIdentityPersistencePolicy = "none" | "required";

export interface EmitEnvelopeInput<TLegacy> {
  type: RuntimeEventType;
  payload: RuntimeEventPayload;
  executionContext: ExecutionContext;
  sequenceAllocator: RunSequenceAllocator;
  legacyEvent: TLegacy;
  eventId?: string;
  now?: () => Date;
  runtimeEventEnvelopeEnabled?: boolean;
  persistencePolicy?: EventIdentityPersistencePolicy;
  eventRepository?: EventRepository;
  persistenceEvent?: TaskEvent;
}

export async function emitEnvelope<TLegacy>(
  input: EmitEnvelopeInput<TLegacy>
): Promise<RuntimeEventEnvelope<RuntimeEventType, RuntimeEventPayload> | TLegacy> {
  const isEnabled =
    input.runtimeEventEnvelopeEnabled ??
    getAgentRuntimeConfig().runtimeEventEnvelopeEnabled;
  if (!isEnabled) {
    return input.legacyEvent;
  }

  const eventId = stableEventId(input.eventId);
  const sequence = input.sequenceAllocator.next(input.executionContext.runId);
  const envelope: RuntimeEventEnvelope<RuntimeEventType, RuntimeEventPayload> = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId,
    sequence,
    type: input.type,
    emittedAt: (input.now ?? (() => new Date()))().toISOString(),
    context: projectExecutionEventContext(input.executionContext),
    payload: parseRuntimeEventPayload(input.type, input.payload),
  };
  runtimeEventEnvelopeSchema.parse(envelope);

  const isTerminal = input.type === "run.terminal";
  const persistencePolicy =
    input.persistencePolicy ?? (isTerminal ? "required" : "none");
  try {
    if (persistencePolicy === "required") {
      const eventRepository = input.eventRepository;
      const persistenceEvent =
        input.persistenceEvent ?? asTaskEvent(input.legacyEvent);
      if (!eventRepository || !persistenceEvent) {
        throw new Error("Required runtime event identity persistence is unavailable");
      }
      await eventRepository.append({
        ...persistenceEvent,
        eventId,
        payload: {
          ...(asRecord(persistenceEvent.payload) ?? {}),
          runtimeEventIdentity: {
            schemaVersion: envelope.schemaVersion,
            eventId,
            sequence,
            type: envelope.type,
            emittedAt: envelope.emittedAt,
            context: envelope.context,
          },
        },
      });
    }
    return envelope;
  } finally {
    if (isTerminal) {
      input.sequenceAllocator.release(input.executionContext.runId);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTaskEvent(value: unknown): TaskEvent | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.taskId !== "string" ||
    !isTaskEventType(candidate.eventType) ||
    typeof candidate.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    eventId: candidate.eventId,
    taskId: candidate.taskId,
    ...(typeof candidate.stepId === "string" ? { stepId: candidate.stepId } : {}),
    eventType: candidate.eventType,
    ...(Object.prototype.hasOwnProperty.call(candidate, "payload")
      ? { payload: candidate.payload }
      : {}),
    createdAt: candidate.createdAt,
  };
}

function isTaskEventType(value: unknown): value is TaskEvent["eventType"] {
  return (
    typeof value === "string" &&
    TASK_EVENT_TYPES.some((eventType) => eventType === value)
  );
}
