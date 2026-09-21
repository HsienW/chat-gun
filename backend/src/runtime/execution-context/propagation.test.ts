import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createRuntimeEvent } from "../../platform/agent-runtime-events.js";
import { createErrorEnvelope, parseErrorEnvelope } from "../../platform/errors.js";
import { recordStepMetric, recordTaskMetric, recordToolMetric } from "../../platform/metrics/instrumentation.js";
import { createMetricsCollector } from "../../platform/metrics/metrics-collector.js";
import { createTaskCreatedEvent, createStepStartedEvent } from "../events.js";
import { createInteractionTaskEvent, createInteractionInputReference } from "../interaction/events.js";
import type { AgentStep, AgentTask } from "../types.js";
import { executionContextSchema } from "./execution-context.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as { validContext: unknown };
const context = executionContextSchema.parse(fixture.validContext);
const correlation = {
  requestId: context.requestId,
  threadId: context.threadId,
  runId: context.runId,
  taskId: context.taskId,
};

describe("canonical context propagation", () => {
  it("adds the same correlation to task and step event payloads", () => {
    const now = "2026-09-20T00:00:00.000Z";
    const task: AgentTask = {
      taskId: context.taskId,
      taskType: "test",
      status: "running",
      steps: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    const step: AgentStep = {
      stepId: context.stepId ?? "step-1",
      stepName: "test",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(createTaskCreatedEvent(task, context).payload).toMatchObject({ correlation });
    expect(createStepStartedEvent(task.taskId, step, context).payload).toMatchObject({ correlation });

    const interaction = createInteractionTaskEvent({
      eventType: "interaction_decision",
      executionContext: context,
      threadId: context.threadId,
      priorTaskId: context.taskId,
      priorRunId: context.runId,
      replacementTaskId: null,
      replacementRunId: null,
      generation: 1,
      input: createInteractionInputReference(new TextEncoder().encode("input")),
      sideEffectState: "read_only",
      compensationResult: null,
      reconciliationResult: null,
    });
    expect(interaction.payload.correlation).toEqual(correlation);
    expect(JSON.stringify(interaction)).not.toContain(context.principal.principalId);
  });

  it("adds canonical correlation to runtime and error envelopes", () => {
    expect(createRuntimeEvent({ type: "agent.answer.stream", delta: "ok" }, context))
      .toMatchObject({ correlation });
    const envelope = createErrorEnvelope(new Error("failed"), {
      source: "backend",
      stage: "tool_invoke",
      executionContext: context,
    });
    expect(parseErrorEnvelope(JSON.stringify(envelope))).toMatchObject({ correlation });
    expect(JSON.stringify(envelope)).not.toContain(context.principal.principalId);
  });

  it("adds one canonical correlation to task, step, and tool metrics", () => {
    const collector = createMetricsCollector();
    recordTaskMetric({ taskId: context.taskId, status: "running" }, collector, context);
    recordStepMetric({ taskId: context.taskId, stepId: context.stepId ?? "step-1", nodeName: "test", status: "running" }, collector, context);
    recordToolMetric({ taskId: context.taskId, stepId: context.stepId ?? "step-1", toolName: "test", status: "success", durationMs: 1 }, collector, context);
    expect(collector.entries()).toHaveLength(3);
    for (const metric of collector.entries()) {
      expect(metric).toMatchObject({ correlation });
    }
  });
});
