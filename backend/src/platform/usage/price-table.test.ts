import { describe, expect, it } from "vitest";
import { parsePriceTable, priceUsage } from "./price-table.js";

const fixture = {
  provider: "fixture", model: "fixture-model", callKind: "chat",
  inputPerMillion: "0.125", outputPerMillion: "0.25", currency: "USD",
  source: "https://pricing.fixture.test/prices", verifiedAt: "2026-11-02",
};

describe("usage price table", () => {
  it("derives currency and calculates micro-units with exact decimal arithmetic", () => {
    const table = parsePriceTable(JSON.stringify([fixture]));
    expect(table.currency).toBe("USD");
    const quote = priceUsage(table, { provider: "fixture", model: "fixture-model", callKind: "chat", inputTokens: 8, outputTokens: 4 });
    expect(quote).toEqual({ amountMicros: 2, status: "priced" });
    expect(Array.from({ length: 10000 }, () => quote.amountMicros ?? 0).reduce((a, b) => a + b, 0)).toBe(20000);
  });

  it("does not use a placeholder price for an unknown model", () => {
    const table = parsePriceTable();
    expect(table.currency).toBeNull();
    expect(priceUsage(table, { provider: "fixture", model: "unknown", callKind: "chat", inputTokens: 8, outputTokens: 4 }))
      .toEqual({ amountMicros: null, status: "unpriced" });
  });

  it("marks missing usage estimated only when an explicit estimate is configured", () => {
    const usage = { provider: "fixture", model: "fixture-model", callKind: "chat" as const, inputTokens: null, outputTokens: null };
    expect(priceUsage(parsePriceTable(JSON.stringify([fixture])), usage)).toEqual({ amountMicros: null, status: "unpriced" });
    expect(priceUsage(parsePriceTable(JSON.stringify([{ ...fixture, missingUsageEstimateMicros: 9 }])), usage))
      .toEqual({ amountMicros: 9, status: "estimated" });
  });

  it("rejects malformed, duplicate and mixed-currency price entries without echoing values", () => {
    for (const entries of [
      [{ ...fixture, inputPerMillion: "-1" }],
      [{ ...fixture, currency: undefined }],
      [fixture, fixture],
      [fixture, { ...fixture, model: "other", currency: "CNY" }],
      [{ ...fixture, verifiedAt: "not-a-date" }],
    ]) {
      expect(() => parsePriceTable(JSON.stringify(entries))).toThrow(/USAGE_PRICE_TABLE_JSON/);
    }
  });
});
