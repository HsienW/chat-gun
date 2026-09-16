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
      })
    ).toEqual({
      signalStatus: "available",
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

    expect(projection.signalStatus).toBe("degraded");
    expect(projection).not.toHaveProperty("workerSaturation");
    expect(projection).not.toHaveProperty("heartbeatFreshnessMs");
    expect(projection.missingSignals).toEqual([
      "run_status",
      "worker_capacity",
      "ownership_progress",
    ]);
  });
});
