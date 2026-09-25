import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyError } from "../retry/error-classification.js";
import { InMemoryToolCircuitBreaker } from "./circuit-breaker.js";
import { FixedWindowToolRateLimiter } from "./rate-limiter.js";
import type {
  ToolCircuitBreakerPolicy,
  ToolRateLimitPolicy,
} from "./runtime-tool-descriptor.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/tool-scheduling-resilience.fixture.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  schemaVersion: string;
  rateLimit: {
    policy: ToolRateLimitPolicy;
    retryAfterMaxMs: number;
    decisions: {
      initial: { type: "allow" };
      overflow: { type: "defer"; retryAfterMs: number };
    };
  };
  circuitBreaker: {
    policy: ToolCircuitBreakerPolicy;
    states: {
      initial: "closed";
      thresholdReached: "open";
      resetElapsed: "half_open";
      recovered: "closed";
    };
  };
  retryOutcomes: {
    definitiveRetryable: { errorCode: string; category: string };
  };
};

describe("tool scheduling resilience cross-layer contract", () => {
  it("keeps rate-limit decisions aligned with the shared fixture", () => {
    const limiter = new FixedWindowToolRateLimiter(
      fixture.rateLimit.retryAfterMaxMs,
      () => 1_000
    );

    expect(limiter.check("fixture_tool", fixture.rateLimit.policy)).toEqual(
      fixture.rateLimit.decisions.initial
    );
    expect(limiter.check("fixture_tool", fixture.rateLimit.policy)).toEqual(
      fixture.rateLimit.decisions.overflow
    );
  });

  it("keeps circuit state transitions aligned with the shared fixture", () => {
    let now = 1_000;
    const breaker = new InMemoryToolCircuitBreaker(() => now);
    const { policy, states } = fixture.circuitBreaker;

    expect(breaker.beforeDispatch("fixture_tool", policy)).toBe(states.initial);
    breaker.record("fixture_tool", policy, "definitive_failure");
    breaker.record("fixture_tool", policy, "definitive_failure");
    expect(breaker.beforeDispatch("fixture_tool", policy)).toBe(
      states.thresholdReached
    );
    now += policy.resetTimeoutMs;
    expect(breaker.beforeDispatch("fixture_tool", policy)).toBe(
      states.resetElapsed
    );
    breaker.record("fixture_tool", policy, "success");
    breaker.record("fixture_tool", policy, "success");
    expect(breaker.beforeDispatch("fixture_tool", policy)).toBe(
      states.recovered
    );
  });

  it("keeps retry classification aligned with the shared fixture", () => {
    const expected = fixture.retryOutcomes.definitiveRetryable;

    expect(
      classifyError({ code: expected.errorCode, message: expected.errorCode })
    ).toMatchObject({ retryable: true, category: expected.category });
  });
});
