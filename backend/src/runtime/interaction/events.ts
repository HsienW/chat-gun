import { createHash, randomUUID } from "node:crypto";

import type { AuditLogger } from "../../platform/observability.js";
import type { SpanManager } from "../../platform/tracing/span-manager.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import { executionCorrelation } from "../execution-context/read-execution-context.js";
import { redact } from "../audit/redaction.js";
import type { EventRepository } from "../persistence/event-repository.js";
import type { TaskEvent, TaskEventType } from "../types.js";
import type { CancellationPhase } from "./cancel-decision.js";
import type { InputClassification } from "./classify.js";

export const INTERACTION_TASK_EVENT_TYPES = [
  "queued",
  "cancelling",
  "cancelled",
  "superseded",
  "rollback_requested",
  "cancelled_after_commit",
  "manual_intervention_required",
  "input_classification_tentative",
  "clarification_requested",
  "clarification_resumed",
  "interaction_decision",
] as const satisfies readonly TaskEventType[];

export type InteractionTaskEventType =
  (typeof INTERACTION_TASK_EVENT_TYPES)[number];

export interface InteractionInputReference {
  digest: string;
  byteLength: number;
  classification?: InputClassification;
}

export interface InteractionEventPayload {
  schemaVersion: "1.0";
  correlation?: ReturnType<typeof executionCorrelation>;
  threadId: string;
  priorTaskId: string;
  priorRunId: string;
  replacementTaskId: string | null;
  replacementRunId: string | null;
  generation: number;
  interruptId?: string;
  input: InteractionInputReference;
  sideEffectState: CancellationPhase;
  compensationResult: string | null;
  reconciliationResult: string | null;
  decision?: {
    strategy: string;
    disposition: string;
    classification?: InputClassification;
    reasonCode: string;
  };
}

export type InteractionTaskEvent = TaskEvent & {
  eventType: InteractionTaskEventType;
  payload: InteractionEventPayload;
};

export interface InteractionEventFactoryDependencies {
  createEventId: () => string;
  now: () => Date;
}

const DEFAULT_FACTORY_DEPENDENCIES: InteractionEventFactoryDependencies = {
  createEventId: randomUUID,
  now: () => new Date(),
};

function requireOpaqueId(value: string, field: string): void {
  if (value.trim() === "" || value.length > 256) {
    throw new Error(`Invalid interaction ${field}`);
  }
}

function requireGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid interaction generation");
  }
}

function isStableMachineIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function requireClarificationInterruptId(value: string): void {
  if (!/^clarification:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid clarification interruptId");
  }
}

export function createClarificationInterruptId(input: {
  threadId: string;
  runId: string;
  checkpointStep: number;
}): string {
  requireOpaqueId(input.threadId, "threadId");
  requireOpaqueId(input.runId, "runId");
  if (!Number.isSafeInteger(input.checkpointStep) || input.checkpointStep < 0) {
    throw new Error("Invalid clarification checkpointStep");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([input.threadId, input.runId, input.checkpointStep]),
    )
    .digest("hex");
  return `clarification:${digest}`;
}

export function createInteractionInputReference(
  payload: Uint8Array,
  classification?: InputClassification
): InteractionInputReference {
  return {
    digest: createHash("sha256").update(payload).digest("hex"),
    byteLength: payload.byteLength,
    ...(classification ? { classification } : {}),
  };
}

export function createInteractionTaskEvent(
  input: Omit<InteractionEventPayload, "schemaVersion" | "correlation"> & {
    eventType: InteractionTaskEventType;
    executionContext?: ExecutionContext;
  },
  dependencies: InteractionEventFactoryDependencies = DEFAULT_FACTORY_DEPENDENCIES
): InteractionTaskEvent {
  requireOpaqueId(input.threadId, "threadId");
  requireOpaqueId(input.priorTaskId, "priorTaskId");
  requireOpaqueId(input.priorRunId, "priorRunId");
  if (input.replacementTaskId) {
    requireOpaqueId(input.replacementTaskId, "replacementTaskId");
  }
  if (input.replacementRunId) {
    requireOpaqueId(input.replacementRunId, "replacementRunId");
  }
  requireGeneration(input.generation);
  if (input.interruptId) {
    requireClarificationInterruptId(input.interruptId);
  }
  if (!/^[a-f0-9]{64}$/.test(input.input.digest)) {
    throw new Error("Invalid interaction input digest");
  }

  return {
    eventId: dependencies.createEventId(),
    taskId: input.priorTaskId,
    eventType: input.eventType,
    payload: {
      schemaVersion: "1.0",
      ...(input.executionContext
        ? { correlation: executionCorrelation(input.executionContext) }
        : {}),
      threadId: input.threadId,
      priorTaskId: input.priorTaskId,
      priorRunId: input.priorRunId,
      replacementTaskId: input.replacementTaskId,
      replacementRunId: input.replacementRunId,
      generation: input.generation,
      ...(input.interruptId ? { interruptId: input.interruptId } : {}),
      input: input.input,
      sideEffectState: input.sideEffectState,
      compensationResult: input.compensationResult,
      reconciliationResult: input.reconciliationResult,
      ...(input.decision ? { decision: input.decision } : {}),
    },
    createdAt: dependencies.now().toISOString(),
  };
}

export function createTentativeClassificationTaskEvents(
  input: {
    executionContext?: ExecutionContext;
    threadId: string;
    priorTaskId: string;
    priorRunId: string;
    generation: number;
    input: InteractionInputReference;
    classificationReasonCode: string;
    classifierVersion: string;
  },
  dependencies: InteractionEventFactoryDependencies = DEFAULT_FACTORY_DEPENDENCIES
): readonly [TaskEvent, TaskEvent] {
  if (!isStableMachineIdentifier(input.classificationReasonCode)) {
    throw new Error("Invalid classification reason code");
  }
  if (!isStableMachineIdentifier(input.classifierVersion)) {
    throw new Error("Invalid classifier version");
  }

  const basePayload = {
    schemaVersion: "1.0" as const,
    ...(input.executionContext
      ? { correlation: executionCorrelation(input.executionContext) }
      : {}),
    threadId: input.threadId,
    priorTaskId: input.priorTaskId,
    priorRunId: input.priorRunId,
    replacementTaskId: null,
    replacementRunId: null,
    generation: input.generation,
    input: input.input,
    sideEffectState: "read_only" as const,
    compensationResult: null,
    reconciliationResult: null,
  };
  const createdAt = dependencies.now().toISOString();

  return [
    {
      eventId: dependencies.createEventId(),
      taskId: input.priorTaskId,
      eventType: "input_classification_tentative",
      payload: {
        ...basePayload,
        classificationReasonCode: input.classificationReasonCode,
        classifierVersion: input.classifierVersion,
      },
      createdAt,
    },
    {
      eventId: dependencies.createEventId(),
      taskId: input.priorTaskId,
      eventType: "waiting_confirmation",
      payload: {
        ...basePayload,
        confirmationType: "input_classification",
      },
      createdAt,
    },
  ];
}

function asInteractionEventPayload(
  payload: unknown
): InteractionEventPayload | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const candidate = payload as Partial<InteractionEventPayload>;
  return candidate.schemaVersion === "1.0" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.priorTaskId === "string" &&
    typeof candidate.priorRunId === "string" &&
    typeof candidate.generation === "number"
    ? (candidate as InteractionEventPayload)
    : undefined;
}

export class InteractionEventRecorder {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly auditLogger: AuditLogger,
    private readonly spanManager: SpanManager
  ) {}

  async record(event: InteractionTaskEvent, executionContext?: ExecutionContext): Promise<void> {
    const payload = asInteractionEventPayload(event.payload);
    if (!payload) throw new Error("Invalid interaction event payload");

    await this.eventRepository.append(event);
    const reasonCode = `INTERACTION_${event.eventType.toUpperCase()}`;
    const auditPayload = redact({
      threadId: payload.threadId,
      taskId: payload.priorTaskId,
      runId: payload.priorRunId,
      replacementTaskId: payload.replacementTaskId,
      replacementRunId: payload.replacementRunId,
      generation: payload.generation,
      ...(payload.interruptId ? { interruptId: payload.interruptId } : {}),
      eventType: event.eventType,
      reasonCode,
      sideEffectState: payload.sideEffectState,
      inputDigest: payload.input.digest,
      inputByteLength: payload.input.byteLength,
      ...(payload.decision
        ? {
            decision: payload.decision.disposition,
            strategy: payload.decision.strategy,
            classification: payload.decision.classification ?? null,
            decisionReasonCode: payload.decision.reasonCode,
          }
        : {}),
    });
    if (auditPayload === null || typeof auditPayload !== "object") {
      throw new Error("Invalid redacted interaction audit payload");
    }
    if (executionContext) {
      await this.auditLogger.record(
        `interaction.${event.eventType}`,
        auditPayload as Record<string, unknown>,
        executionContext
      );
    } else {
      await this.auditLogger.record(
        `interaction.${event.eventType}`,
        auditPayload as Record<string, unknown>
      );
    }

    const span = this.spanManager.getActiveSpan();
    if (span) {
      this.spanManager.setAttributes(span, {
        "interaction.event_type": event.eventType,
        ...(payload.correlation
          ? { "request.id": payload.correlation.requestId }
          : {}),
        "interaction.thread_id": payload.threadId,
        "interaction.task_id": payload.priorTaskId,
        "interaction.run_id": payload.priorRunId,
        "interaction.generation": payload.generation,
        "interaction.side_effect_state": payload.sideEffectState,
        ...(payload.decision
          ? {
              "interaction.decision": payload.decision.disposition,
              "interaction.strategy": payload.decision.strategy,
              "interaction.decision_reason_code": payload.decision.reasonCode,
              ...(payload.decision.classification
                ? {
                    "interaction.classification":
                      payload.decision.classification,
                  }
                : {}),
            }
          : {}),
        ...(payload.replacementRunId
          ? { "interaction.replacement_run_id": payload.replacementRunId }
          : {}),
      });
    }
  }
}
