import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { GovernedToolExecutor } from "../runtime/side-effect/governed-outcome.js";
import type { RuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import {
  createExecutionCompositionRoot,
  type CanonicalExecutionRequest,
  type ExecutionCompositionStage,
} from "./execution-composition-root.js";
import { getIncidentProjectionIndex } from "./incident-query.js";

const EXECUTION_MANIFEST = {
  runtimeBuildId: "build-1",
  graphVersion: "graph-1",
  promptVersion: "prompt-1",
  modelRouteVersion: "route-1",
  toolSchemaVersion: "tool-1",
  policyVersion: "policy-1",
};

const REQUEST: CanonicalExecutionRequest = {
  executionManifest: EXECUTION_MANIFEST,
  principal: {
    principalId: "principal-1",
    principalType: "service",
    tenantId: "tenant-1",
    roles: ["runtime-executor"],
    scopes: ["tools:execute"],
    authSource: "service_token",
    authenticatedAt: "2026-09-28T12:00:00.000Z",
  },
  input: { kind: "prompt", text: "safe canary", attachments: [] },
  scope: {
    scopeId: "scope-1",
    scopeType: "tenant",
    tenantId: "tenant-1",
  },
};

function createRoot() {
  const sourceExecutor: GovernedToolExecutor<unknown, unknown> = {
    async executeTyped(input) {
      return { type: "succeeded", result: input };
    },
  };
  const dispatchPipeline: RuntimeToolDispatchPipeline = {
    createExecutor(_toolName, executor) {
      return {
        async executeTyped(input, config) {
          const outcome = await executor.executeTyped(input, config);
          return {
            type: "succeeded",
            result: {
              schemaVersion: "1.0",
              kind: "tool_result",
              correlation: {
                requestId: "request-1",
                threadId: "thread-1",
                runId: "run-1",
                toolCallId: "tool-call-1",
                stepId: "step-1",
              },
              tool: {
                name: "safe_canary_tool",
                version: "1.0.0",
                riskTier: "read",
                readOnly: true,
              },
              outcome,
              emittedAt: "2026-09-28T12:00:30.000Z",
            },
          };
        },
      };
    },
    hasCompensation: () => false,
    async compensate() {
      throw new Error("not used");
    },
  };

  return createExecutionCompositionRoot({
    createCorrelation: () => ({
      requestId: "request-1",
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      toolCallId: "tool-call-1",
      attempt: 1,
    }),
    dispatchPipeline,
    selectTool: ({ normalizedInput, governedContext }) => ({
      toolName: "safe_canary_tool",
      input: {
        normalizedInput,
        governedContext: governedContext.text,
      },
      sourceExecutor,
    }),
    recovery: {
      async recover({ executionEvent }) {
        return {
          terminal: "completed",
          output: { kind: "canary", eventId: executionEvent.eventId },
        };
      },
    },
    outputSchema: z
      .object({ kind: z.literal("canary"), eventId: z.string().min(1) })
      .strict(),
    collectEvidence: ({ context }) => ({
      auditRef: `audit:${context.runId}`,
      otelTraceRef: `trace:${context.runId}`,
      duplicateEffectCount: 0,
      correlatedSliRef: `sli:${context.runId}`,
    }),
    createEventId: () => "event-1",
    now: () => new Date("2026-09-28T12:01:00.000Z"),
  });
}

describe("ExecutionCompositionRoot", () => {
  it("fails closed when a mandatory request field is missing", async () => {
    const root = createRoot();

    await expect(
      root.execute({
        principal: REQUEST.principal,
        input: REQUEST.input,
        scope: REQUEST.scope,
      })
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("rejects malformed normalized input instead of dispatching", async () => {
    const root = createRoot();

    await expect(
      root.execute({ ...REQUEST, input: { kind: "prompt", text: "" } })
    ).rejects.toThrow("INVALID_NORMALIZED_INPUT");
  });

  it("executes the canonical stages in the fixed order", async () => {
    const root = createRoot();

    const result = await root.execute(REQUEST);

    expect(result.runId).toBe("run-1");
    expect(result.terminal).toBe("completed");
    expect(result.output).toEqual({ kind: "canary", eventId: "event-1" });
    expect(result.evidence).toMatchObject({
      auditRef: "audit:run-1",
      otelTraceRef: "trace:run-1",
      duplicateEffectCount: 0,
      correlatedSliRef: "sli:run-1",
      stages: ["x12", "x17", "x18", "x14", "x19", "x20"] satisfies ExecutionCompositionStage[],
    });
    expect(result.executionEvent).toMatchObject({
      schemaVersion: "1.0.0",
      eventId: "event-1",
      sequence: 1,
      type: "run.execution",
      context: { runId: "run-1", taskId: "task-1" },
    });
    expect(getIncidentProjectionIndex().query("run-1")).toMatchObject({
      schemaVersion: "1.0",
      runId: "run-1",
      audit: [{ reference: "audit:run-1" }],
      traces: [{ reference: "trace:run-1" }],
      toolExecutions: [
        { toolName: "safe_canary_tool", outcome: "succeeded" },
      ],
      terminalResult: { status: "completed" },
    });
  });
});
