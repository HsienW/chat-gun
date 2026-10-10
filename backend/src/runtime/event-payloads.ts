import type { RuntimeEventType } from "@gun-ai/harness-contracts";

export {
  RUNTIME_EVENT_PAYLOAD_SCHEMAS,
  RUNTIME_EVENT_TYPES,
} from "@gun-ai/harness-contracts";
export type {
  JsonValue,
  RuntimeEventPayload,
  RuntimeEventType,
} from "@gun-ai/harness-contracts";
export {
  isRuntimeEventType,
  parseRuntimeEventPayload,
} from "@gun-ai/harness-kernel";

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
