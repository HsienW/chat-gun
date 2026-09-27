import { describe, expect, it } from "vitest";

import {
  LEGACY_RUNTIME_EVENT_TYPE_MAP,
  parseRuntimeEventPayload,
  type RuntimeEventType,
} from "./event-payloads.js";

const categorySamples: Record<RuntimeEventType, unknown> = {
  "run.started": { status: "running" },
  "run.status": { status: "needs_user", reasonCode: "AWAITING_CONFIRMATION" },
  "run.terminal": { status: "timed_out", reasonCode: "UPSTREAM_TIMEOUT" },
  "task.created": { taskId: "task-1", status: "created" },
  "task.completed": { taskId: "task-1", status: "completed" },
  "task.failed": { taskId: "task-1", status: "failed", errorCode: "TASK_FAILED" },
  "task.cancelled": { taskId: "task-1", status: "cancelled" },
  "step.started": { taskId: "task-1", stepId: "step-1", status: "running", attempt: 1 },
  "step.completed": { taskId: "task-1", stepId: "step-1", status: "succeeded", attempt: 1 },
  "step.failed": { taskId: "task-1", stepId: "step-1", status: "terminal_failed", attempt: 1, errorCode: "STEP_FAILED" },
  "step.retrying": { taskId: "task-1", stepId: "step-1", status: "retryable_failed", attempt: 2 },
  "model.stream": { delta: "partial answer" },
  "model.done": { finishReason: "stop" },
  "model.error": { errorCode: "MODEL_ERROR" },
  "tool.start": { toolName: "search", toolCallId: "tool-call-1" },
  "tool.success": { toolName: "search", toolCallId: "tool-call-1", durationMs: 12 },
  "tool.error": { toolName: "search", toolCallId: "tool-call-1", errorCode: "TOOL_ERROR" },
  "permission.request": { permissionId: "permission-1", permission: "tool:execute" },
  "permission.decided": { permissionId: "permission-1", decision: "approved" },
  "reconciliation.status": { status: "reconciled", reasonCode: "STATE_MATCHED" },
  "compensation.triggered": { taskId: "task-1", reasonCode: "ROLLBACK_REQUIRED" },
  "compensation.completed": { taskId: "task-1", outcome: "compensated" },
  "context.build": { sourceCount: 2, tokenEstimate: 512 },
  "card.emit": { cardType: "weather", data: { temperature: 24 } },
};

describe("runtime event payload schemas", () => {
  it.each(Object.entries(categorySamples))("validates %s", (type, payload) => {
    expect(parseRuntimeEventPayload(type, payload)).toEqual(payload);
  });

  it("rejects an unknown event category with a stable error", () => {
    expect(() => parseRuntimeEventPayload("future.event", {})).toThrow(
      /UNKNOWN_RUNTIME_EVENT_TYPE/
    );
  });

  it("rejects user-visible labels from machine payloads", () => {
    expect(() =>
      parseRuntimeEventPayload("task.created", {
        taskId: "task-1",
        status: "created",
        label: "顯示文字不可進入機器契約",
      })
    ).toThrow();
  });
});

describe("legacy runtime event type mapping", () => {
  it("maps legacy snake-case and agent event types from one source", () => {
    expect(LEGACY_RUNTIME_EVENT_TYPE_MAP).toEqual(
      expect.objectContaining({
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
        "agent.answer.stream": "model.stream",
        "agent.tool.start": "tool.start",
        "agent.tool.success": "tool.success",
        "agent.tool.error": "tool.error",
        "agent.context.build": "context.build",
        "agent.card.emit": "card.emit",
      })
    );
  });
});
