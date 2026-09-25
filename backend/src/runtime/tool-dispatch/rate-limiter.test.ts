import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FixedWindowToolRateLimiter } from "./rate-limiter.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/tool-scheduling-resilience.fixture.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  rateLimit: {
    policy: { maxRequestsPerWindow: number; windowMs: number };
    retryAfterMaxMs: number;
    decisions: {
      initial: { type: "allow" };
      overflow: { type: "defer"; retryAfterMs: number };
    };
  };
};

describe("FixedWindowToolRateLimiter", () => {
  it("allows tools without a rate-limit policy", () => {
    const limiter = new FixedWindowToolRateLimiter(1_000);

    expect(limiter.check("read_tool", undefined)).toEqual({ type: "allow" });
  });

  it("allows requests within the configured window capacity", () => {
    let now = 1_000;
    const limiter = new FixedWindowToolRateLimiter(5_000, () => now);
    const policy = { maxRequestsPerWindow: 2, windowMs: 1_000 };

    expect(limiter.check("read_tool", policy)).toEqual({ type: "allow" });
    expect(limiter.check("read_tool", policy)).toEqual({ type: "allow" });

    now = 2_000;
    expect(limiter.check("read_tool", policy)).toEqual({ type: "allow" });
  });

  it("defers requests above the window capacity with a retry hint", () => {
    const limiter = new FixedWindowToolRateLimiter(
      fixture.rateLimit.retryAfterMaxMs,
      () => 1_250
    );
    const policy = fixture.rateLimit.policy;

    expect(limiter.check("read_tool", policy)).toEqual(
      fixture.rateLimit.decisions.initial
    );
    expect(limiter.check("read_tool", policy)).toEqual(
      fixture.rateLimit.decisions.overflow
    );
  });

  it("clamps retry hints to toolRetryAfterMaxMs", () => {
    const limiter = new FixedWindowToolRateLimiter(250, () => 1_000);
    const policy = { maxRequestsPerWindow: 1, windowMs: 10_000 };

    limiter.check("read_tool", policy);

    expect(limiter.check("read_tool", policy)).toEqual({
      type: "defer",
      retryAfterMs: 250,
    });
  });

  it("tracks each tool independently", () => {
    const limiter = new FixedWindowToolRateLimiter(5_000, () => 1_000);
    const policy = { maxRequestsPerWindow: 1, windowMs: 1_000 };

    expect(limiter.check("tool_a", policy)).toEqual({ type: "allow" });
    expect(limiter.check("tool_a", policy).type).toBe("defer");
    expect(limiter.check("tool_b", policy)).toEqual({ type: "allow" });
  });

  it("does not consume window capacity when the signal is already aborted", () => {
    const limiter = new FixedWindowToolRateLimiter(5_000, () => 1_000);
    const policy = { maxRequestsPerWindow: 1, windowMs: 1_000 };
    const controller = new AbortController();
    controller.abort();

    expect(() => limiter.check("read_tool", policy, controller.signal)).toThrow();
    expect(limiter.check("read_tool", policy)).toEqual({ type: "allow" });
  });
});
