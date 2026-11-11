export type LedgerMetadata = { version: "usage-ledger@1"; currency: string; timeZone: string; keyPrefix: string };
export type UsageSnapshot = { date: string; resetAt: number; currency: string; amountMicros: number; unpricedCount: number;
  items: readonly { graphId: string; callKind: string; amountMicros: number; unpricedCount: number }[] };
export interface UsageLedgerReader { read(signal?: AbortSignal): Promise<UsageSnapshot>; }
export interface ReadonlyUsageRedis {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export function ledgerDate(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** First millisecond of the next local calendar date; handles DST without a fixed UTC offset. */
export function nextLedgerDate(now: number, timeZone: string): number {
  const date = ledgerDate(now, timeZone);
  let low = Math.trunc(now), high = low + 48 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (ledgerDate(middle, timeZone) === date) low = middle; else high = middle;
  }
  return high;
}

function integer(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const number = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(number)) throw new Error("usage_budget_unavailable");
  return number;
}

export class SharedUsageLedgerReader implements UsageLedgerReader {
  constructor(private readonly options: { redis: ReadonlyUsageRedis; expected: LedgerMetadata; timeoutMs: number;
    backendMetadata(signal: AbortSignal): Promise<unknown>; now?: () => number; observe?: (event: string) => void }) {
    ledgerDate(Date.now(), options.expected.timeZone);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("invalid_configuration:USAGE_READ_TIMEOUT_MS");
  }

  async read(signal?: AbortSignal): Promise<UsageSnapshot> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.snapshot(controller.signal),
        new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error("usage_budget_unavailable"));
          if (controller.signal.aborted) fail(); else controller.signal.addEventListener("abort", fail, { once: true });
          timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        }),
      ]);
    } catch {
      this.options.observe?.("usage_budget_unavailable");
      throw new Error("usage_budget_unavailable");
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  private async snapshot(signal: AbortSignal): Promise<UsageSnapshot> {
    const expected = this.options.expected;
    const [backend, stored] = await Promise.all([
      this.options.backendMetadata(signal), this.options.redis.get(`${expected.keyPrefix}:metadata`),
    ]);
    const metadata: unknown = stored === null ? null : JSON.parse(stored);
    for (const value of [backend, metadata]) {
      if (!value || typeof value !== "object" || !Object.entries(expected).every(([key, field]) => Reflect.get(value, key) === field)) {
        this.options.observe?.("usage_metadata_mismatch");
        throw new Error("usage_budget_unavailable");
      }
    }
    if (!backend || typeof backend !== "object" || ["ready", "shared", "pricesComplete"].some(key => Reflect.get(backend, key) !== true)) throw new Error("usage_budget_unavailable");
    const now = this.options.now?.() ?? Date.now();
    const date = ledgerDate(now, expected.timeZone);
    const fields = await this.options.redis.hgetall(`${expected.keyPrefix}:daily:${date}`);
    const items = Object.entries(fields).filter(([key]) => key.startsWith("amount:")).map(([key, amount]) => {
      const tuple: unknown = JSON.parse(key.slice(7));
      if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some(value => typeof value !== "string" || value.length === 0)) throw new Error("usage_budget_unavailable");
      const [graphId, callKind] = tuple;
      return { graphId: String(graphId), callKind: String(callKind), amountMicros: integer(amount), unpricedCount: integer(fields[`unpriced:${key.slice(7)}`]) };
    });
    const result = { date, resetAt: nextLedgerDate(now, expected.timeZone), currency: expected.currency,
      amountMicros: integer(fields.amountMicros), unpricedCount: integer(fields.unpricedCount), items };
    if (result.unpricedCount > 0 || !Number.isSafeInteger(items.reduce((sum, item) => sum + item.amountMicros, 0)) || items.reduce((sum, item) => sum + item.amountMicros, 0) !== result.amountMicros) throw new Error("usage_budget_unavailable");
    return result;
  }
}
