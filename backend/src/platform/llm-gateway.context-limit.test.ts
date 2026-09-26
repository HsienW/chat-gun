import { describe, expect, it } from "vitest";

import { ContextHardLimitError } from "../context/context-errors.js";
import { resolveEffectiveContextLimit } from "../context/context-limit.js";

describe("resolveEffectiveContextLimit", () => {
  it("uses the smaller configured budget", () => {
    expect(
      resolveEffectiveContextLimit(
        { contextBudgetTotal: 8_000, contextOutputReserveTokens: 1_000 },
        { contextWindowTokens: 20_000, maxOutputTokens: 2_000 }
      )
    ).toEqual({ effectiveLimit: 8_000, outputReserve: 2_000 });
  });

  it("subtracts the larger output reserve from the provider window", () => {
    expect(
      resolveEffectiveContextLimit(
        { contextBudgetTotal: 20_000, contextOutputReserveTokens: 4_096 },
        { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }
      )
    ).toEqual({ effectiveLimit: 5_904, outputReserve: 4_096 });
  });

  it("falls back to the configured budget for an unknown provider window", () => {
    expect(
      resolveEffectiveContextLimit(
        { contextBudgetTotal: 12_000, contextOutputReserveTokens: 1_000 },
        { contextWindowTokens: 0, maxOutputTokens: 0 }
      )
    ).toEqual({
      effectiveLimit: 12_000,
      outputReserve: 1_000,
      reasonCode: "provider_window_unknown",
    });
  });

  it("fails closed when output reserve consumes the provider window", () => {
    expect(() =>
      resolveEffectiveContextLimit(
        { contextBudgetTotal: 12_000, contextOutputReserveTokens: 10_000 },
        { contextWindowTokens: 8_000, maxOutputTokens: 1_000 }
      )
    ).toThrowError(
      expect.objectContaining<Partial<ContextHardLimitError>>({
        code: "context_config_invalid",
      })
    );
  });
});
