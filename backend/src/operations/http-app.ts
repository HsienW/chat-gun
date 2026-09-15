import { Hono } from "hono";

import { metricsApp } from "../platform/metrics/metrics-endpoint.js";
import { getMetricsCollector } from "../platform/metrics/metrics-collector.js";
import { renderOperationsMetrics } from "./metrics/export.js";

const OPEN_METRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

export const operationsHttpApp = new Hono();

operationsHttpApp.route("/", metricsApp);
operationsHttpApp.all("/operations/metrics", (context) => {
  if (context.req.method !== "GET") {
    return context.json({ error: "Method not allowed" }, 405);
  }

  const exposition = renderOperationsMetrics(getMetricsCollector(), {
    signalStatus: "degraded",
    missingSignals: ["run_status", "worker_capacity", "ownership_progress"],
  });
  return context.body(exposition, 200, { "content-type": OPEN_METRICS_CONTENT_TYPE });
});
