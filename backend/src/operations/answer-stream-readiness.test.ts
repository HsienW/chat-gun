import { afterEach, expect, it, vi } from "vitest";

import { createOperationsHttpApp } from "./http-app.js";
import { projectRuntimeHealth } from "./metrics/health.js";

const healthProbe = () => projectRuntimeHealth({ observedAt: new Date().toISOString(), stuckRunAfterMs: 1, heartbeatStaleAfterMs: 1, processAlive: true,
  redisReachable: true, postgresReachable: true, checkpointReachable: true, recoveryReachable: true, acceptsNewWork: true });

afterEach(() => {
  vi.unstubAllEnvs();
});

it("stays ready by default because answer streaming is disabled", async () => {
  vi.stubEnv("ANSWER_TEXT_STREAMING_ENABLED", "");
  expect((await createOperationsHttpApp({ healthProbe }).request("/health/readiness")).status).toBe(200);
});

it("fails readiness with the wiring reasons when streaming is enabled but unwired", async () => {
  const app = createOperationsHttpApp({
    healthProbe,
    answerStreamReadiness: () => ({ ready: false, reasonCodes: ["answer_stream_wiring_missing"] }),
  });
  const response = await app.request("/health/readiness");

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: "not_ready", reasonCodes: expect.arrayContaining(["answer_stream_wiring_missing"]) });
});

it("fails closed when the streaming setting cannot be read", async () => {
  vi.stubEnv("ANSWER_TEXT_STREAMING_ENABLED", "maybe");
  const response = await createOperationsHttpApp({ healthProbe }).request("/health/readiness");

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ reasonCodes: expect.arrayContaining(["answer_stream_configuration_invalid"]) });
});

it("is ready when streaming is enabled and wired", async () => {
  const app = createOperationsHttpApp({ healthProbe, answerStreamReadiness: () => ({ ready: true, reasonCodes: [] }) });
  expect((await app.request("/health/readiness")).status).toBe(200);
});
