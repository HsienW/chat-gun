import type { PriceTable } from "../platform/usage/price-table.js";
import { validateMonetaryBudgetConfiguration, type EnabledUsageModel } from "../platform/usage/budget-configuration.js";

export function validateDemoBackend(env: NodeJS.ProcessEnv, shared: boolean, prices: PriceTable, models: readonly EnabledUsageModel[], thinkingControlSupported: boolean): void {
  for (const key of ["USAGE_LEDGER_REDIS_URI", "USAGE_LEDGER_KEY_PREFIX", "USAGE_LEDGER_WRITE_TIMEOUT_MS", "USAGE_LEDGER_TIME_ZONE", "USAGE_PRICE_TABLE_JSON"]) {
    if (!env[key]?.trim()) throw new Error(`invalid_configuration:${key}`);
  }
  if (env.SHOPPING_ASSISTANT_THINKING_ENABLED !== "false") throw new Error("invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED");
  if (!thinkingControlSupported) throw new Error("invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED:unsupported_provider_capability");
  if (env.CHAT_THINKING_ENABLED !== undefined && !["true", "false"].includes(env.CHAT_THINKING_ENABLED)) throw new Error("invalid_configuration:CHAT_THINKING_ENABLED");
  validateMonetaryBudgetConfiguration(shared, prices, models);
}
