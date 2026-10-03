import { describe, expect, it } from "vitest";

import {
  FAULT_INJECTION_CATEGORIES,
  classifyCrashRecovery,
  evaluateFaultInjectionDataset,
  type FaultInjectionDataset,
} from "./fault-injection.js";

function createDataset(): FaultInjectionDataset {
  return {
    datasetId: "runtime-production-readiness",
    datasetVersion: "v1.0.0",
    executionMode: "memory_only",
    cases: [
      ...FAULT_INJECTION_CATEGORIES.map((category) => ({
        caseId: `fault-${category}`,
        category,
        expectedGateStatus: "failed" as const,
      })),
      {
        caseId: "control-valid-runtime",
        category: "control" as const,
        expectedGateStatus: "passed" as const,
      },
    ],
  };
}

describe("fault-injection negative checks", () => {
  it("passes only when every deliberate regression fails the gate and the control passes", async () => {
    const result = await evaluateFaultInjectionDataset(
      createDataset(),
      async (faultCase) => faultCase.expectedGateStatus
    );

    expect(result).toMatchObject({ passed: true, failedCaseIds: [] });
  });

  it("routes post-effect/pre-ack to reconciliation and rejects stale ownership", () => {
    expect(classifyCrashRecovery({ category: "post_effect_pre_ack_crash", isEffectAcknowledged: false, isCurrentFencingToken: true })).toBe("reconciliation");
    expect(classifyCrashRecovery({ category: "fenced_worker_takeover", isEffectAcknowledged: false, isCurrentFencingToken: false })).toBe("reject_stale_owner");
    expect(classifyCrashRecovery({ category: "approval_wait_crash", isEffectAcknowledged: false, isCurrentFencingToken: true })).toBe("resume");
  });

  it("fails when a deliberate regression is incorrectly allowed", async () => {
    const result = await evaluateFaultInjectionDataset(
      createDataset(),
      async (faultCase) =>
        faultCase.category === "authorization"
          ? "passed"
          : faultCase.expectedGateStatus
    );

    expect(result).toEqual({
      passed: false,
      failedCaseIds: ["fault-authorization"],
      reasonCode: "FAULT_INJECTION_NEGATIVE_CHECK_FAILED",
    });
  });

  it("rejects unversioned datasets and non-memory-only fixtures", async () => {
    await expect(
      evaluateFaultInjectionDataset(
        { ...createDataset(), datasetVersion: "latest" },
        async () => "failed"
      )
    ).rejects.toThrow();
    await expect(
      evaluateFaultInjectionDataset(
        { ...createDataset(), executionMode: "external" },
        async () => "failed"
      )
    ).rejects.toThrow();
  });
});
