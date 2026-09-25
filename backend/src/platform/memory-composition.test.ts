import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getMemoryComposition,
  resetMemoryCompositionForTests,
} from "./memory-composition.js";

describe("memory composition root", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMemoryCompositionForTests();
  });

  it("constructs and caches the production provider", () => {
    vi.stubEnv("MEMORY_CONTEXT_ENABLED", "true");
    const first = getMemoryComposition();
    const second = getMemoryComposition();

    expect(first.provider).toBeDefined();
    expect(second).toBe(first);
  });

  it("degrades to no memory when the feature is disabled", () => {
    vi.stubEnv("MEMORY_CONTEXT_ENABLED", "false");

    expect(getMemoryComposition()).toEqual({
      provider: undefined,
      degradedReason: "memory_disabled",
    });
  });

  it("fails closed when postgres is selected without a database URL", () => {
    vi.stubEnv("MEMORY_CONTEXT_ENABLED", "true");
    vi.stubEnv("MEMORY_STORE_BACKEND", "postgres");
    vi.stubEnv("DATABASE_URL", "");

    expect(getMemoryComposition()).toEqual({
      provider: undefined,
      degradedReason: "memory_unavailable",
    });
  });
});
