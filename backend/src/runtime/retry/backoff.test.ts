import { afterEach, describe, expect, it, vi } from "vitest";

import { computeBackoff } from "./backoff.js";

describe("computeBackoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
  ])("doubles exponential delay for attempt %i", (attempt, expectedDelay) => {
    expect(computeBackoff("exponential", attempt, { jitter: false })).toBe(
      expectedDelay
    );
  });

  it("caps exponential delay before applying jitter", () => {
    expect(
      computeBackoff("exponential", 10, { maxMs: 5_000, jitter: false })
    ).toBe(5_000);

    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(computeBackoff("exponential", 10, { maxMs: 5_000 })).toBe(6_250);
  });

  it("returns a fixed delay for every attempt when jitter is disabled", () => {
    expect(computeBackoff("fixed", 1, { baseMs: 2_000, jitter: false })).toBe(
      2_000
    );
    expect(computeBackoff("fixed", 5, { baseMs: 2_000, jitter: false })).toBe(
      2_000
    );
  });

  it("uses Retry-After when provided", () => {
    expect(
      computeBackoff("retry-after-header", 1, {
        retryAfterMs: 10_000,
        jitter: false,
      })
    ).toBe(10_000);
  });

  it("caps Retry-After at the configured maximum", () => {
    expect(
      computeBackoff("retry-after-header", 1, {
        retryAfterMs: 60_000,
        maxMs: 2_500,
        jitter: false,
      })
    ).toBe(2_500);
  });

  it("falls back to exponential when Retry-After is absent", () => {
    expect(
      computeBackoff("retry-after-header", 3, {
        baseMs: 500,
        jitter: false,
      })
    ).toBe(2_000);
  });

  it("applies the specified jitter boundaries", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(1);

    expect(computeBackoff("fixed", 1)).toBe(750);
    expect(computeBackoff("fixed", 1)).toBe(1_250);
  });

  it("uses jitter by default", () => {
    const delay = computeBackoff("exponential", 2);

    expect(delay).toBeGreaterThanOrEqual(1_500);
    expect(delay).toBeLessThanOrEqual(2_500);
  });
});
