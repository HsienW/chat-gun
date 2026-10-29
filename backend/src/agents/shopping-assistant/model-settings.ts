import { getEnv } from "../../platform/env.js";

const DEFAULT_INTENT_TIMEOUT_MS = 20_000;

export interface ShoppingAssistantModelSettings {
  /** Undefined uses the gateway's model for each purpose. */
  model: string | undefined;
  temperature: number;
  intentTimeoutMs: number;
}

/** The production graph and the live chain evaluation read the same settings. */
export function readShoppingAssistantModelSettings(read: (name: string) => string = (name) => getEnv(name)): ShoppingAssistantModelSettings {
  const rawTimeout = read("SHOPPING_INTENT_TIMEOUT_MS").trim();
  const intentTimeoutMs = rawTimeout.length === 0 ? DEFAULT_INTENT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isSafeInteger(intentTimeoutMs) || intentTimeoutMs <= 0 || intentTimeoutMs > 120_000) {
    throw new Error("Invalid SHOPPING_INTENT_TIMEOUT_MS");
  }
  const rawTemperature = read("SHOPPING_ASSISTANT_TEMPERATURE").trim();
  const temperature = rawTemperature.length === 0 ? 0 : Number(rawTemperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("Invalid SHOPPING_ASSISTANT_TEMPERATURE");
  }
  return { model: read("SHOPPING_ASSISTANT_MODEL").trim() || undefined, temperature, intentTimeoutMs };
}
