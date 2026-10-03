import { describe, expect, it, vi } from "vitest";

import {
  loadRollingDeployDependencyFactory,
  runRollingDeployCli,
} from "./rolling-deploy.cli.js";

const plan = {
  deploymentId: "deploy-cli-1",
  oldInstanceId: "old-cli",
  newInstanceId: "new-cli",
};

const drain = {
  status: "drained" as const,
  canShutdown: true,
  completedRunIds: [],
  checkpointedRunIds: [],
  parkedRunIds: [],
  reconciledRunIds: [],
  unresolvedRunIds: [],
  timedOut: false,
};

const canary = {
  status: "healthy" as const,
  reasonCode: "CANARY_VERIFIED" as const,
  runtimeBuildId: "build-cli",
  executionManifest: {
    runtimeBuildId: "build-cli",
    graphVersion: "1",
    promptVersion: "1",
    modelRouteVersion: "1",
    toolSchemaVersion: "1",
    policyVersion: "1",
  },
};

describe("rolling deploy CLI", () => {
  it("executes the rollout through an injected dependency factory", async () => {
    const calls: string[] = [];
    const writeOutput = vi.fn();
    const createDependencies = vi.fn(async () => ({
      drainOldInstance: async () => {
        calls.push("drain");
        return drain;
      },
      checkResumeCompatibility: async () => {
        calls.push("compatibility");
        return { status: "compatible" as const };
      },
      runCanary: async () => {
        calls.push("canary");
        return canary;
      },
      shiftTraffic: async () => {
        calls.push("traffic");
      },
    }));

    const exitCode = await runRollingDeployCli({
      environment: {
        ROLLING_DEPLOY_PLAN_JSON: JSON.stringify(plan),
      },
      createDependencies,
      writeOutput,
    });

    expect(exitCode).toBe(0);
    expect(createDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ plan })
    );
    expect(calls).toEqual(["drain", "compatibility", "canary", "traffic"]);
    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining('"status":"completed"')
    );
  });

  it("rejects adapter modules outside the workspace", async () => {
    await expect(
      loadRollingDeployDependencyFactory(
        "../outside-workspace-adapter.ts",
        process.cwd()
      )
    ).rejects.toThrow("ROLLING_DEPLOY_ADAPTER_OUTSIDE_WORKSPACE");
  });

  it("returns a non-zero exit code without shifting traffic when drain blocks", async () => {
    const shiftTraffic = vi.fn(async () => undefined);
    const writeOutput = vi.fn();

    const exitCode = await runRollingDeployCli({
      environment: {
        ROLLING_DEPLOY_PLAN_JSON: JSON.stringify(plan),
      },
      createDependencies: async () => ({
        drainOldInstance: async () => ({
          ...drain,
          status: "blocked",
          canShutdown: false,
          unresolvedRunIds: ["run-unresolved"],
        }),
        checkResumeCompatibility: async () => ({ status: "compatible" }),
        runCanary: async () => canary,
        shiftTraffic,
      }),
      writeOutput,
    });

    expect(exitCode).toBe(1);
    expect(shiftTraffic).not.toHaveBeenCalled();
    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining('"reasonCode":"DRAIN_UNRESOLVED"')
    );
  });
});
