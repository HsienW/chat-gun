import { beforeEach, describe, expect, it } from "vitest";

import {
  createMetricsCollector,
  setMetricsCollector,
} from "../platform/metrics/metrics-collector.js";
import { operationsHttpApp } from "./http-app.js";

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
});
