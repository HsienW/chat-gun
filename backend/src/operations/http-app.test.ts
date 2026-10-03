import { beforeEach, describe, expect, it } from "vitest";

import {
  createMetricsCollector,
  setMetricsCollector,
} from "../platform/metrics/metrics-collector.js";
import { createOperationsHttpApp, operationsHttpApp } from "./http-app.js";
import { projectRuntimeHealth } from "./metrics/health.js";
import { getIncidentProjectionIndex } from "./incident-query.js";

describe("operations HTTP app", () => {
  beforeEach(() => setMetricsCollector(createMetricsCollector()));

  it("preserves the existing JSON snapshot route", async () => {
    const response = await operationsHttpApp.request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("exposes a read-only OpenMetrics route", async () => {
    const response = await operationsHttpApp.request("/operations/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/openmetrics-text"
    );
    expect(await response.text()).toMatch(/# EOF\n$/);

    expect((await operationsHttpApp.request("/operations/metrics", { method: "POST" })).status).toBe(405);
  });

  it("renders OpenMetrics from the injected health probe", async () => {
    const app = createOperationsHttpApp({
      healthProbe: () =>
        projectRuntimeHealth({
          observedAt: "2026-10-02T00:00:00.000Z",
          runs: [
            {
              status: "pending",
              updatedAt: "2026-10-02T00:00:00.000Z",
            },
          ],
          activeWorkerCount: 0,
          workerCapacity: 1,
          latestOwnershipUpdateAt: "2026-10-02T00:00:00.000Z",
          stuckRunAfterMs: 1_000,
          heartbeatStaleAfterMs: 1_000,
          processAlive: true,
          redisReachable: true,
          postgresReachable: true,
          checkpointReachable: true,
          recoveryReachable: true,
          acceptsNewWork: true,
        }),
    });

    const response = await app.request("/operations/metrics");
    const exposition = await response.text();

    expect(response.status).toBe(200);
    expect(exposition).toContain("chat_gun_operations_signal_available 1");
    expect(exposition).toContain("chat_gun_queue_depth 1");
  });

  it("returns a structured incident projection separately from metrics", async () => {
    getIncidentProjectionIndex().record({
      schemaVersion: "1.0",
      runId: "run-http-1",
      events: [],
      audit: [{ reference: "audit:run-http-1" }],
      traces: [],
      toolExecutions: [],
      terminalResult: { status: "completed" },
    });

    const response = await operationsHttpApp.request(
      "/operations/incidents/run-http-1"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: "1.0",
      runId: "run-http-1",
      audit: [{ reference: "audit:run-http-1" }],
    });
    getIncidentProjectionIndex().delete("run-http-1");
  });

  it("validates canonical runId and keeps incident lookup read-only", async () => {
    expect(
      (await operationsHttpApp.request("/operations/incidents/not%20canonical")).status
    ).toBe(400);
    expect(
      (
        await operationsHttpApp.request("/operations/incidents/run-1", {
          method: "POST",
        })
      ).status
    ).toBe(405);
  });

  it("fails readiness closed while keeping liveness independent", async () => {
    const app = createOperationsHttpApp({
      healthProbe: () =>
        projectRuntimeHealth({
          observedAt: "2026-10-02T00:00:00.000Z",
          stuckRunAfterMs: 1_000,
          heartbeatStaleAfterMs: 1_000,
          processAlive: true,
          postgresReachable: false,
          checkpointReachable: false,
          recoveryReachable: false,
          acceptsNewWork: false,
        }),
    });
    expect((await app.request("/health/live")).status).toBe(200);
    expect((await app.request("/health/readiness")).status).toBe(503);
    expect((await app.request("/health/resume-ready")).status).toBe(503);
    expect((await app.request("/health/degraded")).status).toBe(200);
  });
});
