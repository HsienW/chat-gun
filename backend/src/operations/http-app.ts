import { Hono } from "hono";

import { metricsApp } from "../platform/metrics/metrics-endpoint.js";
import { getMetricsCollector } from "../platform/metrics/metrics-collector.js";
import { executionIdSchema } from "../runtime/execution-context/execution-context.js";
import { createSubjectRightsHttpApp } from "../runtime/data-governance/subject-rights-http.js";
import { getIncidentProjectionIndex } from "./incident-query.js";
import { renderOperationsMetrics } from "./metrics/export.js";

const OPEN_METRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

export const operationsHttpApp = new Hono();

type SubjectRightsHttpDependencies = Parameters<typeof createSubjectRightsHttpApp>[0];
let subjectRightsHttpDependencies: SubjectRightsHttpDependencies | undefined;

export function configureSubjectRightsHttp(
  dependencies: SubjectRightsHttpDependencies | undefined,
): void {
  subjectRightsHttpDependencies = dependencies;
}

operationsHttpApp.route("/", metricsApp);
operationsHttpApp.route(
  "/internal/subject-rights",
  new Hono().all("*", async (context) => {
    if (!subjectRightsHttpDependencies) {
      return context.json({
        error: { code: "SUBJECT_RIGHTS_DISABLED", message: "Subject-right service is disabled" },
      }, 503);
    }
    const url = new URL(context.req.url);
    url.pathname = url.pathname.replace(/^\/internal\/subject-rights/u, "") || "/";
    const method = context.req.method;
    const rawBody = method === "GET" || method === "HEAD"
      ? undefined
      : await context.req.arrayBuffer();
    const request = new Request(url, {
      method,
      headers: context.req.raw.headers,
      ...(rawBody && rawBody.byteLength > 0 ? { body: rawBody } : {}),
    });
    return createSubjectRightsHttpApp(subjectRightsHttpDependencies).fetch(request);
  }),
);
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

operationsHttpApp.all("/operations/incidents/:runId", (context) => {
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
