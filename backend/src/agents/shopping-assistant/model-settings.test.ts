import { describe, expect, it } from "vitest";

import { readShoppingAssistantModelSettings } from "./model-settings.js";

const reader = (env: Record<string, string>) => (name: string) => env[name] ?? "";

describe("shopping assistant model settings", () => {
  it("uses the defaults when nothing is configured", () => {
    expect(readShoppingAssistantModelSettings(reader({}))).toEqual({ model: undefined, temperature: 0, intentTimeoutMs: 20_000 });
  });

  it("reads the pinned model, temperature and intent timeout", () => {
    const settings = readShoppingAssistantModelSettings(
      reader({ SHOPPING_ASSISTANT_MODEL: " model-x ", SHOPPING_ASSISTANT_TEMPERATURE: "0.3", SHOPPING_INTENT_TIMEOUT_MS: "15000" })
    );

    expect(settings).toEqual({ model: "model-x", temperature: 0.3, intentTimeoutMs: 15_000 });
  });

  it("rejects out-of-range values instead of falling back", () => {
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_ASSISTANT_TEMPERATURE: "3" }))).toThrow(/SHOPPING_ASSISTANT_TEMPERATURE/u);
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_INTENT_TIMEOUT_MS: "0" }))).toThrow(/SHOPPING_INTENT_TIMEOUT_MS/u);
    expect(() => readShoppingAssistantModelSettings(reader({ SHOPPING_INTENT_TIMEOUT_MS: "200000" }))).toThrow(/SHOPPING_INTENT_TIMEOUT_MS/u);
  });
});
