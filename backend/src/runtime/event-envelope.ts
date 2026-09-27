import { z } from "zod";

import {
  executionContextSchema,
  executionIdSchema,
  type ExecutionContext,
} from "./execution-context/execution-context.js";

export const RUNTIME_EVENT_SCHEMA_VERSION = "1.0.0" as const;

export interface RuntimeEventSchemaVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ExecutionEventContext {
  requestId: string;
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  toolCallId?: string;
  toolExecutionId?: string;
  parentRunId?: string;
  agentId?: string;
  attempt: number;
  principalId: string;
  tenantId: string;
  scopeId: string;
  scopeType: string;
}

export interface RuntimeEventEnvelope<
  TType extends string,
  TPayload,
> {
  schemaVersion: string;
  eventId: string;
  sequence: number;
  type: TType;
  emittedAt: string;
  context: ExecutionEventContext;
  payload: TPayload;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const eventTypePattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export const executionEventContextSchema: z.ZodType<ExecutionEventContext> = z
  .object({
    requestId: executionIdSchema,
    threadId: executionIdSchema,
    runId: executionIdSchema,
    taskId: executionIdSchema,
    stepId: executionIdSchema.optional(),
    toolCallId: executionIdSchema.optional(),
    toolExecutionId: executionIdSchema.optional(),
    parentRunId: executionIdSchema.optional(),
    agentId: executionIdSchema.optional(),
    attempt: z.number().int().positive(),
    principalId: executionIdSchema,
    tenantId: executionIdSchema,
    scopeId: executionIdSchema,
    scopeType: z.string().min(1).max(64),
  })
  .strict();

export const runtimeEventEnvelopeSchema = z
  .object({
    schemaVersion: z.string().regex(semverPattern),
    eventId: executionIdSchema,
    sequence: z.number().int().positive().safe(),
    type: z.string().regex(eventTypePattern),
    emittedAt: z.string().datetime(),
    context: executionEventContextSchema,
    payload: z.unknown(),
  })
  .strict()
  .refine(
    (envelope) => Object.prototype.hasOwnProperty.call(envelope, "payload"),
    { message: "payload is required", path: ["payload"] }
  );

export function parseRuntimeEventSchemaVersion(
  value: string
): RuntimeEventSchemaVersion {
  const match = semverPattern.exec(value);
  if (!match) {
    throw new Error(`Invalid runtime event schema version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function projectExecutionEventContext(
  context: ExecutionContext
): ExecutionEventContext {
  const validated = executionContextSchema.parse(context);
  return executionEventContextSchema.parse({
    requestId: validated.requestId,
    threadId: validated.threadId,
    runId: validated.runId,
    taskId: validated.taskId,
    ...(validated.stepId ? { stepId: validated.stepId } : {}),
    ...(validated.toolCallId ? { toolCallId: validated.toolCallId } : {}),
    ...(validated.toolExecutionId
      ? { toolExecutionId: validated.toolExecutionId }
      : {}),
    ...(validated.parentRunId ? { parentRunId: validated.parentRunId } : {}),
    ...(validated.agentId ? { agentId: validated.agentId } : {}),
    attempt: validated.attempt,
    principalId: validated.principal.principalId,
    tenantId: validated.principal.tenantId,
    scopeId: validated.scope.scopeId,
    scopeType: validated.scope.scopeType,
  });
}

export function parseRuntimeEventEnvelope(
  value: unknown
): z.infer<typeof runtimeEventEnvelopeSchema> {
  return runtimeEventEnvelopeSchema.parse(value);
}
