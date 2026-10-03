import { describe, expect, it, vi } from "vitest";
import { runRollingDeployment } from "./rolling-deploy.js";

const drain = {
  status: "drained_with_recovery" as const,
  canShutdown: true,
  completedRunIds: ["completed"],
  checkpointedRunIds: ["checkpointed"],
  parkedRunIds: ["parked"],
  reconciledRunIds: ["reconciled"],
  unresolvedRunIds: [],
  timedOut: false,
};
const canary = {
  status: "healthy" as const,
  reasonCode: "CANARY_VERIFIED" as const,
  runtimeBuildId: "build-2",
  executionManifest: { runtimeBuildId: "build-2", graphVersion: "1", promptVersion: "1", modelRouteVersion: "1", toolSchemaVersion: "1", policyVersion: "1" },
};

describe("rolling deployment", () => {
  it("drains, verifies compatibility and canary, then shifts traffic", async () => {
    const calls: string[] = [];
    const result = await runRollingDeployment(
      { deploymentId: "deploy-1", oldInstanceId: "old", newInstanceId: "new" },
      {
        drainOldInstance: vi.fn(async () => { calls.push("drain"); return drain; }),
        checkResumeCompatibility: vi.fn(async () => { calls.push("compatibility"); return { status: "compatible" as const }; }),
        runCanary: vi.fn(async () => { calls.push("canary"); return canary; }),
        shiftTraffic: vi.fn(async () => { calls.push("traffic"); }),
      }
    );
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["drain", "compatibility", "canary", "traffic"]);
  });

  it("stops before traffic when canary is unhealthy", async () => {
    const shiftTraffic = vi.fn(async () => undefined);
    const result = await runRollingDeployment(
      { deploymentId: "deploy-1", oldInstanceId: "old", newInstanceId: "new" },
      {
        drainOldInstance: async () => drain,
        checkResumeCompatibility: async () => ({ status: "compatible" }),
        runCanary: async () => ({ ...canary, status: "unhealthy", reasonCode: "CANARY_EXECUTION_FAILED" }),
        shiftTraffic,
      }
    );
    expect(result).toMatchObject({ status: "stopped", reasonCode: "CANARY_UNHEALTHY" });
    expect(shiftTraffic).not.toHaveBeenCalled();
  });
});
