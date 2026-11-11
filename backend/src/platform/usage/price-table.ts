import { z } from "zod";

export const USAGE_CALL_KINDS = ["chat", "embedding", "rerank", "vision"] as const;
export type UsageCallKind = typeof USAGE_CALL_KINDS[number];

const decimalPrice = z.string().regex(/^\d+(?:\.\d{1,12})?$/u);
const priceEntrySchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  callKind: z.enum(USAGE_CALL_KINDS),
  inputPerMillion: decimalPrice,
  outputPerMillion: decimalPrice,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  source: z.string().url(),
  verifiedAt: z.string().date(),
  missingUsageEstimateMicros: z.number().int().positive().safe().optional(),
}).strict();

export type PriceEntry = z.infer<typeof priceEntrySchema>;
export type PriceTable = { readonly entries: readonly PriceEntry[]; readonly currency: string | null };
export type ProviderUsage = {
  provider: string;
  model: string;
  callKind: UsageCallKind;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type UsagePrice =
  | { status: "priced" | "estimated"; amountMicros: number }
  | { status: "unpriced"; amountMicros: null };

function entryKey(entry: Pick<PriceEntry, "provider" | "model" | "callKind">): string {
  return JSON.stringify([entry.provider, entry.model, entry.callKind]);
}

export function parsePriceTable(raw?: string): PriceTable {
  try {
    const entries = z.array(priceEntrySchema).parse(raw?.trim() ? JSON.parse(raw) : []);
    if (new Set(entries.map(entryKey)).size !== entries.length || new Set(entries.map(e => e.currency)).size > 1) {
      throw new Error("inconsistent_price_table");
    }
    return Object.freeze({ entries: Object.freeze(entries), currency: entries[0]?.currency ?? null });
  } catch {
    throw new Error("invalid_configuration:USAGE_PRICE_TABLE_JSON");
  }
}

// A per-million currency price multiplied by tokens already yields micro-currency.
// Keep decimal fractions rational until the single final rounding per provider response.
function decimalFraction(price: string): { numerator: bigint; denominator: bigint } {
  const [whole, fraction = ""] = price.split(".");
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}

export function priceUsage(table: PriceTable, usage: ProviderUsage): UsagePrice {
  const entry = table.entries.find(candidate => entryKey(candidate) === entryKey(usage));
  if (!entry) return { status: "unpriced", amountMicros: null };
  if (usage.inputTokens === null || usage.outputTokens === null) {
    return entry.missingUsageEstimateMicros === undefined
      ? { status: "unpriced", amountMicros: null }
      : { status: "estimated", amountMicros: entry.missingUsageEstimateMicros };
  }
  if (![usage.inputTokens, usage.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("invalid_provider_usage");
  }
  const input = decimalFraction(entry.inputPerMillion);
  const output = decimalFraction(entry.outputPerMillion);
  const denominator = input.denominator * output.denominator;
  const numerator = BigInt(usage.inputTokens) * input.numerator * output.denominator
    + BigInt(usage.outputTokens) * output.numerator * input.denominator;
  const amountMicros = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(amountMicros)) throw new Error("usage_amount_out_of_range");
  return { status: "priced", amountMicros };
}
