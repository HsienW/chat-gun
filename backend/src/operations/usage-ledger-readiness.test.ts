import { expect, it } from "vitest";
import { createOperationsHttpApp } from "./http-app.js";
import { projectRuntimeHealth } from "./metrics/health.js";

const healthProbe = () => projectRuntimeHealth({ observedAt: new Date().toISOString(), stuckRunAfterMs: 1, heartbeatStaleAfterMs: 1, processAlive: true,
  redisReachable: true, postgresReachable: true, checkpointReachable: true, recoveryReachable: true, acceptsNewWork: true });
it("keeps the default readiness and fails closed on an injected shared-storage readiness failure", async () => {
  expect((await createOperationsHttpApp({ healthProbe }).request("/health/readiness")).status).toBe(200);
  for (const acceptNewWorkCheck of [async () => false, async (): Promise<boolean> => { throw new Error("connection fixture"); }]) {
    const response = await createOperationsHttpApp({ healthProbe, acceptNewWorkCheck }).request("/health/readiness");
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ status: "not_ready" });
  }
  expect((await createOperationsHttpApp({ healthProbe, acceptNewWorkCheck: async () => true }).request("/health/readiness")).status).toBe(200);
});

it("returns currency and metadata without exposing a storage URI", async () => {
  const app = createOperationsHttpApp({ healthProbe, usageMetadata: async () => ({ version: "usage-ledger@1", currency: "USD", timeZone: "Asia/Singapore", keyPrefix: "fixture", shared: true, ready: true, pricesComplete: true }) });
  const response = await app.request("/internal/usage-ledger/metadata");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version: "usage-ledger@1", currency: "USD", timeZone: "Asia/Singapore", keyPrefix: "fixture", shared: true, ready: true, pricesComplete: true });
});
