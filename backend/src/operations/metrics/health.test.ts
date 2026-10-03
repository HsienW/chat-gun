import { describe, expect, it } from "vitest";

import { projectRuntimeHealth } from "./health.js";

describe("projectRuntimeHealth", () => {
  it("projects queue, stuck-run, saturation, and ownership freshness signals", () => {
    expect(
      projectRuntimeHealth({
        observedAt: "2026-09-14T00:00:10.000Z",
        runs: [
          { status: "pending", updatedAt: "2026-09-14T00:00:09.000Z" },
          { status: "running", updatedAt: "2026-09-14T00:00:00.000Z" },
        ],
        activeWorkerCount: 3,
        workerCapacity: 4,
        latestOwnershipUpdateAt: "2026-09-14T00:00:08.000Z",
        stuckRunAfterMs: 5_000,
        heartbeatStaleAfterMs: 5_000,
        redisReachable: true,
        postgresReachable: true,
        checkpointReachable: true,
        recoveryReachable: true,
        acceptsNewWork: true,
        multiInstanceSafe: true,
        deploymentPolicySource: "environment",
      })
    ).toEqual({
      alive: { status: "ready", reasonCodes: [] },
      reachable: { status: "ready", reasonCodes: [] },
      acceptNewWork: { status: "ready", reasonCodes: [] },
      resumeDurableWork: { status: "ready", reasonCodes: [] },
      degraded: { status: "normal", reasonCodes: [] },
      deploymentPolicySource: "environment",
      multiInstanceSafe: true,
      queueDepth: 1,
      activeRunCount: 1,
      stuckRunCount: 1,
      workerSaturation: 0.75,
      heartbeatFreshnessMs: 2_000,
      isHeartbeatStale: false,
      missingSignals: [],
    });
  });

  it("degrades without inventing unavailable native worker signals", () => {
    const projection = projectRuntimeHealth({
      observedAt: "2026-09-14T00:00:10.000Z",
      stuckRunAfterMs: 5_000,
      heartbeatStaleAfterMs: 5_000,
    });

    expect(projection.reachable.status).toBe("not_ready");
    expect(projection.acceptNewWork.status).toBe("not_ready");
    expect(projection.resumeDurableWork.status).toBe("not_ready");
    expect(projection).not.toHaveProperty("workerSaturation");
    expect(projection).not.toHaveProperty("heartbeatFreshnessMs");
    expect(projection.missingSignals).toEqual([
      "run_status",
      "worker_capacity",
      "ownership_progress",
    ]);
  });

  it("represents read-only degradation independently from readiness", () => {
    const projection = projectRuntimeHealth({
      observedAt: "2026-09-14T00:00:10.000Z",
      stuckRunAfterMs: 5_000,
      heartbeatStaleAfterMs: 5_000,
      redisReachable: true,
      postgresReachable: true,
      checkpointReachable: true,
      recoveryReachable: true,
      acceptsNewWork: true,
      readOnlyDegraded: true,
    });
    expect(projection.acceptNewWork.status).toBe("ready");
    expect(projection.degraded.status).toBe("read_only");
  });
});
