import { Hono } from "hono";

import { metricsApp } from "../platform/metrics/metrics-endpoint.js";
import { getMetricsCollector } from "../platform/metrics/metrics-collector.js";
import { executionIdSchema } from "../runtime/execution-context/execution-context.js";
import { getIncidentProjectionIndex } from "./incident-query.js";
import { renderOperationsMetrics } from "./metrics/export.js";
import { projectRuntimeHealth, type RuntimeHealthProjection } from "./metrics/health.js";

const OPEN_METRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

export interface OperationsHttpAppDependencies {
  healthProbe(): Promise<RuntimeHealthProjection> | RuntimeHealthProjection;
}

const defaultHealthProbe = () =>
  projectRuntimeHealth({
    observedAt: new Date().toISOString(),
    stuckRunAfterMs: 1,
    heartbeatStaleAfterMs: 1,
    processAlive: true,
  });

export function createOperationsHttpApp(
  dependencies: OperationsHttpAppDependencies = { healthProbe: defaultHealthProbe }
) {
const app = new Hono();

app.route("/", metricsApp);
app.get("/health/live", async (context) => {
  const health = await dependencies.healthProbe();
  return context.json(health.alive, health.alive.status === "ready" ? 200 : 503);
});
app.get("/health/readiness", async (context) => {
  const health = await dependencies.healthProbe();
  return context.json(
    { ...health.acceptNewWork, degraded: health.degraded },
    health.acceptNewWork.status === "ready" ? 200 : 503
  );
});
app.get("/health/resume-ready", async (context) => {
  const health = await dependencies.healthProbe();
  return context.json(
    health.resumeDurableWork,
    health.resumeDurableWork.status === "ready" ? 200 : 503
  );
});
app.get("/health/degraded", async (context) =>
  context.json((await dependencies.healthProbe()).degraded, 200)
);
app.all("/operations/metrics", async (context) => {
  if (context.req.method !== "GET") {
    return context.json({ error: "Method not allowed" }, 405);
  }

  const exposition = renderOperationsMetrics(
    getMetricsCollector(),
    await dependencies.healthProbe()
  );
  return context.body(exposition, 200, { "content-type": OPEN_METRICS_CONTENT_TYPE });
});

app.all("/operations/incidents/:runId", (context) => {
  if (context.req.method !== "GET") {
    return context.json({ error: "Method not allowed" }, 405);
  }
  const runId = executionIdSchema.safeParse(context.req.param("runId"));
  if (!runId.success) {
    return context.json({ error: "Invalid runId" }, 400);
  }
  const projection = getIncidentProjectionIndex().query(runId.data);
  return projection
    ? context.json(projection, 200)
    : context.json({ error: "Incident not found" }, 404);
});

return app;
}

export const operationsHttpApp = createOperationsHttpApp();
