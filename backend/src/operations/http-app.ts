import { Hono } from "hono";

import { metricsApp } from "../platform/metrics/metrics-endpoint.js";
import { getMetricsCollector } from "../platform/metrics/metrics-collector.js";
import { executionIdSchema } from "../runtime/execution-context/execution-context.js";
import { createSubjectRightsHttpApp } from "../runtime/data-governance/subject-rights-http.js";
import { getIncidentProjectionIndex } from "./incident-query.js";
import { renderOperationsMetrics } from "./metrics/export.js";
import { projectRuntimeHealth, type RuntimeHealthProjection } from "./metrics/health.js";

const OPEN_METRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

type SubjectRightsHttpDependencies = Parameters<typeof createSubjectRightsHttpApp>[0];

export interface OperationsHttpAppDependencies {
  healthProbe(): Promise<RuntimeHealthProjection> | RuntimeHealthProjection;
  subjectRightsProvider?(): SubjectRightsHttpDependencies | undefined;
}

let subjectRightsHttpDependencies: SubjectRightsHttpDependencies | undefined;

export function configureSubjectRightsHttp(
  dependencies: SubjectRightsHttpDependencies | undefined,
): void {
  subjectRightsHttpDependencies = dependencies;
}

const defaultHealthProbe = () =>
  projectRuntimeHealth({
    observedAt: new Date().toISOString(),
    stuckRunAfterMs: 1,
    heartbeatStaleAfterMs: 1,
    processAlive: true,
  });

function createSubjectRightsProxy(
  resolveDependencies: () => SubjectRightsHttpDependencies | undefined,
) {
  return new Hono().all("*", async (context) => {
    const dependencies = resolveDependencies();
    if (!dependencies) {
      return context.json(
        {
          error: {
            code: "SUBJECT_RIGHTS_DISABLED",
            message: "Subject-right service is disabled",
          },
        },
        503,
      );
    }

    const url = new URL(context.req.url);
    url.pathname = url.pathname.replace(/^\/internal\/subject-rights/u, "") || "/";
    const method = context.req.method;
    const rawBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : await context.req.arrayBuffer();
    const request = new Request(url, {
      method,
      headers: context.req.raw.headers,
      ...(rawBody && rawBody.byteLength > 0 ? { body: rawBody } : {}),
    });
    return createSubjectRightsHttpApp(dependencies).fetch(request);
  });
}

export function createOperationsHttpApp(
  dependencies: OperationsHttpAppDependencies = { healthProbe: defaultHealthProbe },
) {
  const app = new Hono();

  app.route("/", metricsApp);
  app.route(
    "/internal/subject-rights",
    createSubjectRightsProxy(
      dependencies.subjectRightsProvider ?? (() => undefined),
    ),
  );
  app.get("/health/live", async (context) => {
    const health = await dependencies.healthProbe();
    return context.json(health.alive, health.alive.status === "ready" ? 200 : 503);
  });
  app.get("/health/readiness", async (context) => {
    const health = await dependencies.healthProbe();
    return context.json(
      { ...health.acceptNewWork, degraded: health.degraded },
      health.acceptNewWork.status === "ready" ? 200 : 503,
    );
  });
  app.get("/health/resume-ready", async (context) => {
    const health = await dependencies.healthProbe();
    return context.json(
      health.resumeDurableWork,
      health.resumeDurableWork.status === "ready" ? 200 : 503,
    );
  });
  app.get("/health/degraded", async (context) =>
    context.json((await dependencies.healthProbe()).degraded, 200),
  );
  app.all("/operations/metrics", async (context) => {
    if (context.req.method !== "GET") {
      return context.json({ error: "Method not allowed" }, 405);
    }

    const exposition = renderOperationsMetrics(
      getMetricsCollector(),
      await dependencies.healthProbe(),
    );
    return context.body(exposition, 200, {
      "content-type": OPEN_METRICS_CONTENT_TYPE,
    });
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

export const operationsHttpApp = createOperationsHttpApp({
  healthProbe: defaultHealthProbe,
  subjectRightsProvider: () => subjectRightsHttpDependencies,
});
