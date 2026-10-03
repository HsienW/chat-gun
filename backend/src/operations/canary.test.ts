import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { GovernedToolExecutor } from "../runtime/side-effect/governed-outcome.js";
import type { RuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import { RunSequenceAllocator } from "../runtime/event-sequence.js";

import {
  runLiveRuntimeCanary,
  runSafeCanaryMockTool,
  wireExecutionCompositionCanaryDependencies,
  type CanaryDependencies,
} from "./canary.js";
import { createExecutionCompositionRoot } from "./execution-composition-root.js";
import {
  createAuthoritativeIncidentProjection,
  createInMemoryIncidentFactStore,
} from "./incident-query.js";
import { RUN_OUTCOME_METRIC_CLASSES } from "./metrics/export.js";

const MANIFEST = {
  runtimeBuildId: "build-1",
  graphVersion: "graph-1",
  promptVersion: "prompt-1",
  modelRouteVersion: "route-1",
  toolSchemaVersion: "tool-1",
  policyVersion: "policy-1",
};

function createDependencies(
  overrides: Partial<CanaryDependencies> = {}
): CanaryDependencies {
  return {
    createTask: vi.fn(async () => ({ taskId: "task-canary" })),
    createStep: vi.fn(async () => ({ stepId: "step-canary" })),
    persistTaskStepEvent: vi.fn(async () => undefined),
    invokeSafeMockTool: vi.fn(async (input) =>
      runSafeCanaryMockTool(input)
    ),
    checkpointAndInterrupt: vi.fn(async () => ({
      checkpointId: "checkpoint-canary",
    })),
    resumeFromCheckpoint: vi.fn(async () => undefined),
    verifyAuditAndTrace: vi.fn(async () => ({
      hasAudit: true,
      hasOtelTrace: true,
      duplicateEffectCount: 0,
    })),
    cleanup: vi.fn(async () => ({ cleanupTraceRef: "trace://cleanup-1" })),
    markDeploymentHealth: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("live runtime canary", () => {
  it("uses the real execution composition root in default wiring", async () => {
    const safeOutput = runSafeCanaryMockTool({
      canaryId: "canary-root",
      nonce: "nonce-root",
    });
    const sourceExecutor: GovernedToolExecutor<unknown, unknown> = {
      executeTyped: vi.fn(async () => ({
        type: "succeeded" as const,
        result: safeOutput,
      })),
    };
    const dispatchPipeline: RuntimeToolDispatchPipeline = {
      createExecutor() {
        return {
          async executeTyped() {
            return {
              type: "succeeded",
              result: {
                schemaVersion: "1.0",
                kind: "tool_result",
                correlation: {
                  requestId: "request-canary",
                  threadId: "thread-canary",
                  runId: "run-canary",
                  taskId: "task-canary",
                  stepId: "step-canary",
                  toolCallId: "tool-call-canary",
                },
                tool: {
                  name: "safe_canary_tool",
                  version: "1.0.0",
                  riskTier: "read",
                  readOnly: true,
                },
                outcome: { type: "succeeded", result: safeOutput },
                emittedAt: "2026-09-28T12:00:00.000Z",
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
    const root = createExecutionCompositionRoot({
      createCorrelation: () => ({
        requestId: "request-canary",
        threadId: "thread-canary",
        runId: "run-canary",
        taskId: "task-canary",
        stepId: "step-canary",
        toolCallId: "tool-call-canary",
        attempt: 1,
      }),
      dispatchPipeline,
      selectTool: () => ({
        toolName: "safe_canary_tool",
        input: safeOutput,
        sourceExecutor,
      }),
      recovery: {
        async recover() {
          return { terminal: "completed", output: safeOutput };
        },
      },
      outputSchema: z.object({
        resourceKind: z.literal("memory_only"),
        effectId: z.string(),
        digest: z.string(),
      }).strict(),
      collectEvidence: () => ({
        auditRef: "audit:run-canary",
        otelTraceRef: "trace:run-canary",
        duplicateEffectCount: 0,
        correlatedSliRef: "sli:run-canary",
      }),
      createEventId: () => "event-canary",
      sequenceAllocator: new RunSequenceAllocator(),
      incidentProjection: createAuthoritativeIncidentProjection(
        createInMemoryIncidentFactStore()
      ),
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    const execute = vi.spyOn(root, "execute");
    const dependencies = wireExecutionCompositionCanaryDependencies(
      createDependencies(),
      {
        root,
        createRequest: ({ canaryId, nonce }) => ({
          executionManifest: MANIFEST,
          principal: {
            principalId: "canary-service",
            principalType: "service",
            tenantId: "tenant-canary",
            roles: ["runtime-canary"],
            scopes: ["tools:execute"],
            authSource: "service_token",
            authenticatedAt: "2026-09-28T12:00:00.000Z",
          },
          input: {
            kind: "prompt",
            text: `${canaryId}:${nonce}`,
            attachments: [],
          },
          scope: {
            scopeId: "scope-canary",
            scopeType: "tenant",
            tenantId: "tenant-canary",
          },
        }),
        queryOutcomeMetricClasses: (runId) =>
          runId === "run-canary" ? RUN_OUTCOME_METRIC_CLASSES : [],
      }
    );

    const result = await runLiveRuntimeCanary(
      {
        canaryId: "canary-root",
        nonce: "nonce-root",
        runtimeBuildId: "build-1",
        executionManifest: MANIFEST,
        timeoutMs: 1_000,
      },
      dependencies
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "healthy",
      reasonCode: "CANARY_VERIFIED",
      runId: "run-canary",
      duplicateEffectCount: 0,
      outcomeMetricsVerified: true,
      frontendEnvelopeVerified: true,
      runtimeBuildId: "build-1",
      executionManifest: MANIFEST,
    });
  });

  it("executes the bounded lifecycle and records build/manifest/cleanup", async () => {
    const dependencies = createDependencies();

    const result = await runLiveRuntimeCanary(
      {
        canaryId: "canary-1",
        nonce: "nonce-1",
        runtimeBuildId: "build-1",
        executionManifest: MANIFEST,
        timeoutMs: 1_000,
      },
      dependencies
    );

    expect(result).toMatchObject({
      status: "healthy",
      runtimeBuildId: "build-1",
      executionManifest: MANIFEST,
      taskId: "task-canary",
      stepId: "step-canary",
      checkpointId: "checkpoint-canary",
      cleanupTraceRef: "trace://cleanup-1",
      duplicateEffectCount: 0,
    });
    expect(dependencies.resumeFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "checkpoint-canary" }),
      expect.any(AbortSignal)
    );
    expect(dependencies.markDeploymentHealth).toHaveBeenCalledWith(
      "healthy",
      expect.any(Object)
    );
  });

  it("detects duplicate effects and marks the deployment unhealthy", async () => {
    const dependencies = createDependencies({
      verifyAuditAndTrace: async () => ({
        hasAudit: true,
        hasOtelTrace: true,
        duplicateEffectCount: 1,
      }),
    });

    const result = await runLiveRuntimeCanary(
      {
        canaryId: "canary-2",
        nonce: "nonce-2",
        runtimeBuildId: "build-1",
        executionManifest: MANIFEST,
        timeoutMs: 1_000,
      },
      dependencies
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reasonCode: "CANARY_DUPLICATE_EFFECT",
      duplicateEffectCount: 1,
    });
    expect(dependencies.markDeploymentHealth).toHaveBeenCalledWith(
      "unhealthy",
      expect.any(Object)
    );
  });

  it("cleans up and marks unhealthy when a lifecycle step fails", async () => {
    const dependencies = createDependencies({
      createStep: async () => {
        throw new Error("simulated failure");
      },
    });

    const result = await runLiveRuntimeCanary(
      {
        canaryId: "canary-3",
        nonce: "nonce-3",
        runtimeBuildId: "build-1",
        executionManifest: MANIFEST,
        timeoutMs: 1_000,
      },
      dependencies
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reasonCode: "CANARY_EXECUTION_FAILED",
      cleanupTraceRef: "trace://cleanup-1",
    });
    expect(dependencies.cleanup).toHaveBeenCalled();
    expect(dependencies.markDeploymentHealth).toHaveBeenCalledWith(
      "unhealthy",
      expect.any(Object)
    );
  });

  it("uses a deterministic memory-only safe mock tool contract", () => {
    const first = runSafeCanaryMockTool({
      canaryId: "canary-safe",
      nonce: "nonce-safe",
    });
    const second = runSafeCanaryMockTool({
      canaryId: "canary-safe",
      nonce: "nonce-safe",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      resourceKind: "memory_only",
      effectId: expect.stringMatching(/^canary-effect:/),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
