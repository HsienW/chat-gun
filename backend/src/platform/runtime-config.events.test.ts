import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentRuntimeConfig } from "./runtime-config.js";

describe("runtime event envelope configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables versioned runtime events by default", () => {
    vi.stubEnv("RUNTIME_EVENT_ENVELOPE_ENABLED", "");

    expect(getAgentRuntimeConfig().runtimeEventEnvelopeEnabled).toBe(true);
  });

  it("supports an explicit legacy rollback", () => {
    vi.stubEnv("RUNTIME_EVENT_ENVELOPE_ENABLED", "false");

    expect(getAgentRuntimeConfig().runtimeEventEnvelopeEnabled).toBe(false);
  });

  it("fails closed when the rollout flag is invalid", () => {
    vi.stubEnv("RUNTIME_EVENT_ENVELOPE_ENABLED", "sometimes");

    expect(() => getAgentRuntimeConfig()).toThrow(
      "RUNTIME_EVENT_ENVELOPE_ENABLED must be true or false"
    );
  });
});
