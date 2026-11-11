import type { PriceTable, UsageCallKind } from "./price-table.js";

export type EnabledUsageModel = { provider: string; model: string; callKind: UsageCallKind };

/** Necessary for every monetary policy, regardless of the deployment profile. */
export function validateMonetaryBudgetConfiguration(shared: boolean, prices: PriceTable, models: readonly EnabledUsageModel[]): void {
  if (!shared) throw new Error("invalid_configuration:USAGE_LEDGER_REDIS_URI");
  if (!prices.currency || models.length === 0 || models.some(model => !prices.entries.some(entry =>
    entry.provider === model.provider && entry.model === model.model && entry.callKind === model.callKind))) {
    throw new Error("invalid_configuration:USAGE_PRICE_TABLE_JSON:enabled_model_unpriced");
  }
}
