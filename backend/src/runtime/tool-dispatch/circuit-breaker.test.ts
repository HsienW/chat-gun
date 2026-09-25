import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { InMemoryToolCircuitBreaker } from "./circuit-breaker.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/tool-scheduling-resilience.fixture.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  circuitBreaker: {
    policy: {
      failureThreshold: number;
      successThreshold: number;
      resetTimeoutMs: number;
      halfOpenMaxProbes: number;
    };
  };
};
const policy = fixture.circuitBreaker.policy;

describe("InMemoryToolCircuitBreaker", () => {
  it("opens after definitive failures reach the threshold", () => {
    const breaker = new InMemoryToolCircuitBreaker(() => 1_000);

    breaker.record("read_tool", policy, "definitive_failure");
    expect(breaker.beforeDispatch("read_tool", policy)).toBe("closed");
    breaker.record("read_tool", policy, "definitive_failure");

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("open");
  });

  it("keeps an open circuit from granting a dispatch probe before reset", () => {
    const breaker = new InMemoryToolCircuitBreaker(() => 1_000);
    breaker.record("read_tool", { ...policy, failureThreshold: 1 }, "definitive_failure");

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("open");
  });

  it("enters half-open after resetTimeoutMs", () => {
    let now = 1_000;
    const breaker = new InMemoryToolCircuitBreaker(() => now);
    breaker.record("read_tool", { ...policy, failureThreshold: 1 }, "definitive_failure");

    now = 2_000;

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");
  });

  it("limits half-open probes", () => {
    let now = 1_000;
    const breaker = new InMemoryToolCircuitBreaker(() => now);
    breaker.record("read_tool", { ...policy, failureThreshold: 1 }, "definitive_failure");
    now = 2_000;

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");
    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");
    expect(breaker.beforeDispatch("read_tool", policy)).toBe("open");
  });

  it("closes after enough successful half-open probes", () => {
    let now = 1_000;
    const breaker = new InMemoryToolCircuitBreaker(() => now);
    breaker.record("read_tool", { ...policy, failureThreshold: 1 }, "definitive_failure");
    now = 2_000;

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");
    breaker.record("read_tool", policy, "success");
    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");
    breaker.record("read_tool", policy, "success");

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("closed");
  });

  it("reopens when a half-open probe definitively fails", () => {
    let now = 1_000;
    const breaker = new InMemoryToolCircuitBreaker(() => now);
    breaker.record("read_tool", { ...policy, failureThreshold: 1 }, "definitive_failure");
    now = 2_000;
    expect(breaker.beforeDispatch("read_tool", policy)).toBe("half_open");

    breaker.record("read_tool", policy, "definitive_failure");

    expect(breaker.beforeDispatch("read_tool", policy)).toBe("open");
  });

  it("remains closed when no policy is declared", () => {
    const breaker = new InMemoryToolCircuitBreaker();

    breaker.record("read_tool", undefined, "definitive_failure");

    expect(breaker.beforeDispatch("read_tool", undefined)).toBe("closed");
  });
});
