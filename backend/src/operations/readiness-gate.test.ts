import { describe, expect, it, vi } from "vitest";

import {
  createReadinessGate,
  type ReadinessGateDependencies,
  type ReadinessGateInput,
} from "./readiness-gate.js";

const INPUT: ReadinessGateInput = {
  policyRef: {
    policyId: "runtime-production",
    version: "v1",
    digest: "sha256:policy-v1",
  },
  runtimeBuildId: "build-1",
  executionManifest: {
    runtimeBuildId: "build-1",
    graphVersion: "graph-1",
    promptVersion: "prompt-1",
    modelRouteVersion: "route-1",
    toolSchemaVersion: "tool-1",
    policyVersion: "policy-1",
  },
  faultInjectionDataset: {
    datasetId: "runtime-faults",
    datasetVersion: "v1.0.0",
  },
  canarySpec: { canaryId: "canary-1", timeoutMs: 1_000 },
};

function passingDependencies(
  order: string[] = []
): ReadinessGateDependencies {
  return {
    architectureChecks: vi.fn(async () => {
      order.push("architecture");
      return { passed: true, evidenceRef: "arch:1" };
    }),
    canary: vi.fn(async () => {
      order.push("canary");
      return { passed: true, evidenceRef: "canary:1" };
    }),
    deterministicGate: vi.fn(async () => {
      order.push("deterministic");
      return { passed: true, evidenceRef: "gate:1" };
    }),
    faultInjection: vi.fn(async () => {
      order.push("fault-injection");
      return { passed: true, evidenceRef: "faults:1" };
    }),
    correlatedSli: vi.fn(async () => {
      order.push("correlated-sli");
      return { passed: true, evidenceRef: "sli:1" };
    }),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  };
}

describe("ReadinessGate", () => {
  it("runs every required check in the fixed order", async () => {
    const order: string[] = [];
    const result = await createReadinessGate(passingDependencies(order)).evaluate(INPUT);

    expect(order).toEqual([
      "architecture",
      "canary",
      "deterministic",
      "fault-injection",
      "correlated-sli",
    ]);
    expect(result).toEqual({
      status: "passed",
      evaluatedAt: "2026-09-28T12:00:00.000Z",
      evidence: ["arch:1", "canary:1", "gate:1", "faults:1", "sli:1"],
    });
  });

  it.each([
    ["architectureChecks", "ARCHITECTURE_CHECK_FAILED"],
    ["canary", "CANARY_FAILED"],
    ["deterministicGate", "DETERMINISTIC_GATE_FAILED"],
    ["faultInjection", "FAULT_INJECTION_NEGATIVE_CHECK_FAILED"],
    ["correlatedSli", "CORRELATED_SLI_TOLERANCE_FAILED"],
  ] as const)("fails when %s fails", async (dependency, reasonCode) => {
    const dependencies = passingDependencies();
    dependencies[dependency] = vi.fn(async () => ({
      passed: false,
      reasonCode,
    }));

    const result = await createReadinessGate(dependencies).evaluate(INPUT);

    expect(result).toMatchObject({ status: "failed", reasons: [reasonCode] });
  });

  it("fails closed as invalid_policy for missing or mismatched policy input", async () => {
    const gate = createReadinessGate(passingDependencies());

    await expect(gate.evaluate({ ...INPUT, policyRef: undefined })).resolves.toMatchObject({
      status: "invalid_policy",
      reasonCode: "READINESS_POLICY_INVALID",
    });
    await expect(
      gate.evaluate({
        ...INPUT,
        executionManifest: { ...INPUT.executionManifest, runtimeBuildId: "other-build" },
      })
    ).resolves.toMatchObject({
      status: "invalid_policy",
      reasonCode: "RUNTIME_BUILD_MANIFEST_MISMATCH",
    });
  });
});
