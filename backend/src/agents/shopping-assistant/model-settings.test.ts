import { describe, expect, expectTypeOf, it } from "vitest";

import { readShoppingAssistantModelSettings, type ShoppingAssistantModelSettings } from "./model-settings.js";

const reader = (env: Record<string, string>) => (name: string) => env[name] ?? "";

describe("shopping assistant model settings", () => {
  it("uses the defaults when nothing is configured", () => {
    expect(readShoppingAssistantModelSettings(reader({}))).toEqual({ model: undefined, temperature: 0, intentTimeoutMs: 20_000, thinkingEnabled: false });
  });

  it("reads the pinned model, temperature and intent timeout", () => {
    const settings = readShoppingAssistantModelSettings(
      reader({ SHOPPING_ASSISTANT_MODEL: " model-x ", SHOPPING_ASSISTANT_TEMPERATURE: "0.3", SHOPPING_INTENT_TIMEOUT_MS: "15000" })
    );

    expect(settings).toEqual({ model: "model-x", temperature: 0.3, intentTimeoutMs: 15_000, thinkingEnabled: false });
  });

  it("rejects out-of-range values instead of falling back", () => {
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_ASSISTANT_TEMPERATURE: "3" }))).toThrow(/SHOPPING_ASSISTANT_TEMPERATURE/u);
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_INTENT_TIMEOUT_MS: "0" }))).toThrow(/SHOPPING_INTENT_TIMEOUT_MS/u);
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_INTENT_TIMEOUT_MS: "200000" }))).toThrow(/SHOPPING_INTENT_TIMEOUT_MS/u);
  });

  it("returns thinking as a required boolean that is always false", () => {
    expectTypeOf<ShoppingAssistantModelSettings["thinkingEnabled"]>().toEqualTypeOf<false>();
    // A required key: the property cannot be omitted, so callers never pass undefined to the gateway.
    expectTypeOf<undefined>().not.toMatchTypeOf<ShoppingAssistantModelSettings["thinkingEnabled"]>();
    expect(readShoppingAssistantModelSettings(reader({ SHOPPING_ASSISTANT_THINKING_ENABLED: "false" })).thinkingEnabled).toBe(false);
  });

  it("is not affected by the gateway-wide thinking default", () => {
    const settings = readShoppingAssistantModelSettings(reader({ LLM_THINKING_DEFAULT_ENABLED: "true" }));
    expect(settings.thinkingEnabled).toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "off"])("rejects %s with the stable configuration code in every mode", (value) => {
    for (const mode of ["", "demo", "production"]) {
      expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_ASSISTANT_THINKING_ENABLED: value, DEPLOYMENT_MODE: mode })))
        .toThrow(/^invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED$/u);
    }
  });
});
