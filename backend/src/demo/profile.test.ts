import { describe, expect, it } from "vitest";
import { parsePriceTable } from "../platform/usage/price-table.js";
import { validateMonetaryBudgetConfiguration } from "../platform/usage/budget-configuration.js";
import { createUsageRuntime } from "../platform/usage/runtime.js";
import { validateDemoBackend } from "./profile.js";

const model = { provider: "qwen", model: "fixture-chat", callKind: "chat" as const };
const prices = parsePriceTable(JSON.stringify([{ ...model, currency: "USD", inputPerMillion: "1.2", outputPerMillion: "2.4", source: "https://example.test/fixture", verifiedAt: "2026-11-02" }]));
const environment = () => ({ USAGE_LEDGER_REDIS_URI: "redis://127.0.0.1:6379", USAGE_LEDGER_KEY_PREFIX: "fixture", USAGE_LEDGER_WRITE_TIMEOUT_MS: "100", USAGE_LEDGER_TIME_ZONE: "Asia/Singapore", USAGE_PRICE_TABLE_JSON: "fixture-only", SHOPPING_ASSISTANT_THINKING_ENABLED: "false" });

describe("monetary configuration and Demo backend profile", () => {
  it("requires shared storage and prices for every primary/fallback/knowledge model", () => {
    expect(() => validateMonetaryBudgetConfiguration(false, prices, [model])).toThrow("USAGE_LEDGER_REDIS_URI");
    for (const missing of [{ ...model, model: "fallback" }, { ...model, callKind: "embedding" as const }]) {
      expect(() => validateMonetaryBudgetConfiguration(true, prices, [model, missing])).toThrow("enabled_model_unpriced");
    }
    expect(() => validateMonetaryBudgetConfiguration(true, prices, [model])).not.toThrow();
  });
  it("validates every required setting without secret values", () => {
    const env: NodeJS.ProcessEnv = environment();
    for (const key of Object.keys(env)) {
      const incomplete = { ...env }; delete incomplete[key];
      expect(() => validateDemoBackend(incomplete, true, prices, [model], true), key).toThrow(`invalid_configuration:${key}`);
    }
    expect(() => validateDemoBackend({ ...env, SHOPPING_ASSISTANT_THINKING_ENABLED: "true" }, true, prices, [model], true)).toThrow("THINKING_ENABLED");
    expect(() => validateDemoBackend(env, true, prices, [model], false)).toThrow("unsupported_provider_capability");
    expect(() => validateDemoBackend(env, true, prices, [model], true)).not.toThrow();
  });
  it("uses memory without connecting, rejects invalid generic configuration before listening", async () => {
    const runtime = createUsageRuntime({}); expect(runtime.isShared).toBe(false); expect(await runtime.ready()).toBe(false); await runtime.close();
    for (const env of [{ USAGE_PRICE_TABLE_JSON: "not-json" }, { USAGE_LEDGER_TIME_ZONE: "invalid/timezone" }, { USAGE_LEDGER_WRITE_TIMEOUT_MS: "49" }]) expect(() => createUsageRuntime(env)).toThrow("invalid_configuration");
  });
});
