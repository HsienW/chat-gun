import { describe, expect, it } from "vitest";

import { createExecutionContextFixture } from "@gun-ai/harness-testkit";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  parseRuntimeEventEnvelope,
  parseRuntimeEventSchemaVersion,
  projectExecutionEventContext,
} from "./event-envelope.js";

const executionContext = createExecutionContextFixture({
  stepId: "step-1",
  toolCallId: "tool-call-1",
  toolExecutionId: "tool-execution-1",
  parentRunId: "parent-run-1",
  agentId: "agent-1",
  attempt: 2,
  principal: {
    roles: ["operator"],
    scopes: ["tool:execute"],
    authenticatedAt: "2026-09-27T00:00:00.000Z",
  },
});

function createEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "event-1",
    sequence: 1,
    type: "task.created",
    emittedAt: "2026-09-27T00:00:00.000Z",
    context: projectExecutionEventContext(executionContext),
    payload: { taskId: "task-1", taskType: "research" },
  };
}

describe("RuntimeEventEnvelope", () => {
  it("accepts a complete strict envelope and projects only safe context fields", () => {
    const parsed = parseRuntimeEventEnvelope(createEnvelope());

    expect(parsed.context).toEqual({
      requestId: "request-1",
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      toolCallId: "tool-call-1",
      toolExecutionId: "tool-execution-1",
      parentRunId: "parent-run-1",
      agentId: "agent-1",
      attempt: 2,
      principalId: "principal-1",
      tenantId: "tenant-1",
      scopeId: "scope-1",
      scopeType: "tenant",
    });
    expect(JSON.stringify(parsed.context)).not.toMatch(
      /credential|token|roles|scopes|authSource|AbortSignal|stream/i
    );
  });

  it.each(["eventId", "sequence"])("rejects a missing %s", (field) => {
    const envelope = createEnvelope();
    delete envelope[field];
    expect(() => parseRuntimeEventEnvelope(envelope)).toThrow();
  });

  it.each([0, -1, 1.5])("rejects invalid sequence %s", (sequence) => {
    expect(() => parseRuntimeEventEnvelope({ ...createEnvelope(), sequence })).toThrow();
  });

  it("rejects sensitive or unknown context fields", () => {
    const envelope = createEnvelope();
    envelope.context = {
      ...(envelope.context as Record<string, unknown>),
      credential: "must-not-cross-boundary",
    };

    expect(() => parseRuntimeEventEnvelope(envelope)).toThrow();
  });

  it("parses semantic versions into major, minor and patch", () => {
    expect(parseRuntimeEventSchemaVersion("12.34.56")).toEqual({
      major: 12,
      minor: 34,
      patch: 56,
    });
    expect(() => parseRuntimeEventSchemaVersion("1.0")).toThrow();
  });
});
