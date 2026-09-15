import { describe, expect, it, vi } from "vitest";

import {
  runLiveRuntimeCanary,
  runSafeCanaryMockTool,
  type CanaryDependencies,
} from "./canary.js";

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
