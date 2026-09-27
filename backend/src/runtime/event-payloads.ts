import { z } from "zod";

import { RUN_TERMINAL_STATUSES, RUN_WAITING_STATUSES } from "./run-status.js";
import { STEP_STATUSES, TASK_STATUSES } from "./types.js";

export const RUNTIME_EVENT_TYPES = [
  "run.started",
  "run.status",
  "run.terminal",
  "task.created",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "step.started",
  "step.completed",
  "step.failed",
  "step.retrying",
  "model.stream",
  "model.done",
  "model.error",
  "tool.start",
  "tool.success",
  "tool.error",
  "permission.request",
  "permission.decided",
  "reconciliation.status",
  "compensation.triggered",
  "compensation.completed",
  "context.build",
  "card.emit",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export const LEGACY_RUNTIME_EVENT_TYPE_MAP = {
  task_created: "task.created",
  task_completed: "task.completed",
  task_failed: "task.failed",
  task_cancelled: "task.cancelled",
  step_started: "step.started",
  step_completed: "step.completed",
  step_failed: "step.failed",
  step_retrying: "step.retrying",
  compensation_triggered: "compensation.triggered",
  compensation_completed: "compensation.completed",
  "agent.plan.start": "run.started",
  "agent.answer.stream": "model.stream",
  "agent.tool.start": "tool.start",
  "agent.tool.success": "tool.success",
  "agent.tool.error": "tool.error",
  "agent.context.build": "context.build",
  "agent.card.emit": "card.emit",
} as const satisfies Record<string, RuntimeEventType>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const opaqueIdSchema = z.string().trim().min(1).max(256);
const machineIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const reasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z0-9][A-Z0-9_]*$/);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ])
);
const runStatusSchema = z.enum([
  "running",
  ...RUN_WAITING_STATUSES,
  ...RUN_TERMINAL_STATUSES,
]);

const taskPayload = (status: (typeof TASK_STATUSES)[number]) =>
  z
    .object({
      taskId: opaqueIdSchema,
      status: z.literal(status),
      errorCode: reasonCodeSchema.optional(),
    })
    .strict();

const stepPayload = (status: (typeof STEP_STATUSES)[number]) =>
  z
    .object({
      taskId: opaqueIdSchema,
      stepId: opaqueIdSchema,
      status: z.literal(status),
      attempt: z.number().int().positive(),
      errorCode: reasonCodeSchema.optional(),
    })
    .strict();

export const RUNTIME_EVENT_PAYLOAD_SCHEMAS = {
  "run.started": z.object({ status: z.literal("running") }).strict(),
  "run.status": z
    .object({ status: runStatusSchema, reasonCode: reasonCodeSchema.optional() })
    .strict(),
  "run.terminal": z
    .object({
      status: z.enum(RUN_TERMINAL_STATUSES),
      reasonCode: reasonCodeSchema,
    })
    .strict(),
  "task.created": taskPayload("created"),
  "task.completed": taskPayload("completed"),
  "task.failed": taskPayload("failed"),
  "task.cancelled": taskPayload("cancelled"),
  "step.started": stepPayload("running"),
  "step.completed": stepPayload("succeeded"),
  "step.failed": z
    .object({
      taskId: opaqueIdSchema,
      stepId: opaqueIdSchema,
      status: z.enum(["retryable_failed", "terminal_failed"]),
      attempt: z.number().int().positive(),
      errorCode: reasonCodeSchema,
    })
    .strict(),
  "step.retrying": stepPayload("retryable_failed"),
  "model.stream": z.object({ delta: z.string().max(65_536) }).strict(),
  "model.done": z
    .object({ finishReason: machineIdentifierSchema.optional() })
    .strict(),
  "model.error": z.object({ errorCode: reasonCodeSchema }).strict(),
  "tool.start": z
    .object({ toolName: machineIdentifierSchema, toolCallId: opaqueIdSchema })
    .strict(),
  "tool.success": z
    .object({
      toolName: machineIdentifierSchema,
      toolCallId: opaqueIdSchema,
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  "tool.error": z
    .object({
      toolName: machineIdentifierSchema,
      toolCallId: opaqueIdSchema,
      errorCode: reasonCodeSchema,
    })
    .strict(),
  "permission.request": z
    .object({
      permissionId: opaqueIdSchema,
      permission: machineIdentifierSchema,
    })
    .strict(),
  "permission.decided": z
    .object({
      permissionId: opaqueIdSchema,
      decision: z.enum(["approved", "denied"]),
    })
    .strict(),
  "reconciliation.status": z
    .object({
      status: z.enum(["pending", "reconciled", "diverged"]),
      reasonCode: reasonCodeSchema,
    })
    .strict(),
  "compensation.triggered": z
    .object({ taskId: opaqueIdSchema, reasonCode: reasonCodeSchema })
    .strict(),
  "compensation.completed": z
    .object({
      taskId: opaqueIdSchema,
      outcome: z.enum(["compensated", "partially_compensated", "failed"]),
    })
    .strict(),
  "context.build": z
    .object({
      sourceCount: z.number().int().nonnegative(),
      tokenEstimate: z.number().int().nonnegative(),
    })
    .strict(),
  "card.emit": z
    .object({ cardType: machineIdentifierSchema, data: jsonValueSchema })
    .strict(),
} as const satisfies Record<RuntimeEventType, z.ZodTypeAny>;

export type RuntimeEventPayload = z.infer<
  (typeof RUNTIME_EVENT_PAYLOAD_SCHEMAS)[RuntimeEventType]
>;

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return RUNTIME_EVENT_TYPES.some((eventType) => eventType === value);
}

export function parseRuntimeEventPayload(
  type: string,
  payload: unknown
): RuntimeEventPayload {
  if (!isRuntimeEventType(type)) {
    throw new Error(`UNKNOWN_RUNTIME_EVENT_TYPE: ${type}`);
  }
  const schema: z.ZodTypeAny = RUNTIME_EVENT_PAYLOAD_SCHEMAS[type];
  return schema.parse(payload);
}
