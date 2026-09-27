import { createHash } from "node:crypto";

import { getAgentRuntimeConfig } from "../platform/runtime-config.js";
import type { ExecutionContext } from "./execution-context/execution-context.js";
import {
  parseRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
} from "./event-envelope.js";
import {
  LEGACY_RUNTIME_EVENT_TYPE_MAP,
  parseRuntimeEventPayload,
  type JsonValue,
  type RuntimeEventPayload,
  type RuntimeEventType,
} from "./event-payloads.js";
import { emitEnvelope } from "./emit-envelope.js";
import { RunSequenceAllocator } from "./event-sequence.js";

export interface LegacyRuntimeEventAdapterOptions {
  enabled?: boolean;
  sequenceAllocator?: RunSequenceAllocator;
}

export class LegacyRuntimeEventAdapter {
  private readonly enabled: boolean;
  private readonly sequenceAllocator: RunSequenceAllocator;

  constructor(options: LegacyRuntimeEventAdapterOptions = {}) {
    this.enabled =
      options.enabled ?? getAgentRuntimeConfig().runtimeEventEnvelopeEnabled;
    this.sequenceAllocator = options.sequenceAllocator ?? new RunSequenceAllocator();
  }

  async adapt<TLegacy extends object>(
    event: TLegacy,
    executionContext: ExecutionContext
  ): Promise<
    RuntimeEventEnvelope<RuntimeEventType, RuntimeEventPayload> | TLegacy
  > {
    if (!this.enabled) {
      return event;
    }

    const record = asRecord(event);
    if (typeof record.schemaVersion === "string") {
      const parsed = parseRuntimeEventEnvelope(event);
      parseRuntimeEventPayload(parsed.type, parsed.payload);
      return event;
    }

    const legacyType = readLegacyType(record);
    const type = mapLegacyType(legacyType);
    const eventId = readEventId(record) ?? createSyntheticEventId(event);
    const payload = toCanonicalPayload(
      type,
      record,
      eventId,
      executionContext
    );

    return emitEnvelope({
      type,
      payload,
      executionContext,
      sequenceAllocator: this.sequenceAllocator,
      legacyEvent: event,
      eventId,
      runtimeEventEnvelopeEnabled: true,
      now: () => readLegacyDate(record),
    });
  }
}

function readLegacyType(record: Record<string, unknown>): string {
  const value =
    typeof record.eventType === "string" ? record.eventType : record.type;
  if (typeof value !== "string") {
    throw new Error("UNKNOWN_RUNTIME_EVENT_TYPE: missing legacy type");
  }
  return value;
}

function mapLegacyType(legacyType: string): RuntimeEventType {
  if (Object.prototype.hasOwnProperty.call(LEGACY_RUNTIME_EVENT_TYPE_MAP, legacyType)) {
    return LEGACY_RUNTIME_EVENT_TYPE_MAP[
      legacyType as keyof typeof LEGACY_RUNTIME_EVENT_TYPE_MAP
    ];
  }
  throw new Error(`UNKNOWN_RUNTIME_EVENT_TYPE: ${legacyType}`);
}

function readEventId(record: Record<string, unknown>): string | undefined {
  return typeof record.eventId === "string" && record.eventId.trim()
    ? record.eventId
    : undefined;
}

function readLegacyDate(record: Record<string, unknown>): Date {
  if (typeof record.createdAt === "string") {
    const date = new Date(record.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof record.ts === "number" && Number.isFinite(record.ts)) {
    return new Date(record.ts);
  }
  return new Date();
}

function toCanonicalPayload(
  type: RuntimeEventType,
  event: Record<string, unknown>,
  eventId: string,
  executionContext: ExecutionContext
): RuntimeEventPayload {
  const legacyPayload = asRecord(event.payload) ?? {};
  const taskId = readString(event.taskId) ?? executionContext.taskId;
  const step = asRecord(legacyPayload.step) ?? {};
  const stepId =
    readString(event.stepId) ?? readString(step.stepId) ?? executionContext.stepId;
  const attempt = readPositiveInteger(step.attempt) ?? executionContext.attempt;
  const toolName = readMachineIdentifier(event.toolName) ?? "legacy_tool";
  const toolCallId = executionContext.toolCallId ?? `${eventId}:tool`;

  const payload: RuntimeEventPayload = (() => {
    switch (type) {
      case "run.started":
        return { status: "running" };
      case "task.created":
        return { taskId, status: "created" };
      case "task.completed":
        return { taskId, status: "completed" };
      case "task.failed":
        return { taskId, status: "failed", errorCode: "LEGACY_TASK_FAILED" };
      case "task.cancelled":
        return { taskId, status: "cancelled" };
      case "step.started":
        return { taskId, stepId: requireStepId(stepId), status: "running", attempt };
      case "step.completed":
        return { taskId, stepId: requireStepId(stepId), status: "succeeded", attempt };
      case "step.failed":
        return {
          taskId,
          stepId: requireStepId(stepId),
          status: step.status === "retryable_failed" ? "retryable_failed" : "terminal_failed",
          attempt,
          errorCode: "LEGACY_STEP_FAILED",
        };
      case "step.retrying":
        return {
          taskId,
          stepId: requireStepId(stepId),
          status: "retryable_failed",
          attempt,
        };
      case "model.stream":
        return { delta: readString(event.delta) ?? "" };
      case "tool.start":
        return { toolName, toolCallId };
      case "tool.success":
        return {
          toolName,
          toolCallId,
          durationMs: readNonNegativeInteger(event.costMs) ?? 0,
        };
      case "tool.error":
        return { toolName, toolCallId, errorCode: "LEGACY_TOOL_ERROR" };
      case "context.build":
        return {
          sourceCount: Array.isArray(event.sources) ? event.sources.length : 0,
          tokenEstimate: readNonNegativeInteger(event.tokenEstimate) ?? 0,
        };
      case "card.emit":
        return {
          cardType: readMachineIdentifier(event.cardType) ?? "legacy_card",
          data: toJsonValue(event.payload),
        };
      case "compensation.triggered":
        return { taskId, reasonCode: "LEGACY_COMPENSATION_TRIGGERED" };
      case "compensation.completed":
        return { taskId, outcome: "compensated" };
      default:
        throw new Error(`UNSUPPORTED_LEGACY_RUNTIME_EVENT_TYPE: ${type}`);
    }
  })();
  return parseRuntimeEventPayload(type, payload);
}

function createSyntheticEventId(event: object): string {
  const canonical = JSON.stringify(toJsonValue(event));
  return `legacy:${createHash("sha256").update(canonical).digest("hex")}`;
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Legacy runtime event contains a cycle");
    seen.add(value);
    const result = value.map((item) => toJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (seen.has(record)) throw new Error("Legacy runtime event contains a cycle");
  seen.add(record);
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined && typeof item !== "function") {
      result[key] = toJsonValue(item, seen);
    }
  }
  seen.delete(record);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMachineIdentifier(value: unknown): string | undefined {
  const text = readString(value);
  return text && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(text)
    ? text
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function requireStepId(value: string | undefined): string {
  if (!value) throw new Error("Legacy step event is missing stepId");
  return value;
}
