import { randomUUID } from "node:crypto";
import type { UsageAttribution } from "./attribution.js";
import { priceUsage, type PriceTable, type ProviderUsage, type UsagePrice } from "./price-table.js";

export type UsageLedgerRecord = ProviderUsage & UsagePrice & {
  recordId: string;
  recordedAt: string;
  date: string;
  graphId: string;
  currency: string | null;
};
export type UsageLedgerSummary = {
  date: string;
  currency: string | null;
  amountMicros: number;
  unpricedCount: number;
  byGraphAndKind: Record<string, { graphId: string; callKind: ProviderUsage["callKind"]; amountMicros: number; unpricedCount: number }>;
};
export interface UsageLedgerStore {
  append(record: UsageLedgerRecord): Promise<void>;
  read(date: string): Promise<UsageLedgerSummary>;
}
export const USAGE_LEDGER_TTL_SECONDS = 48 * 60 * 60;

export function datePartition(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseLedgerWriteTimeout(raw?: string): number {
  const timeout = raw === undefined ? 1000 : Number(raw);
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 5000) throw new Error("invalid_configuration:USAGE_LEDGER_WRITE_TIMEOUT_MS");
  return timeout;
}

export function emptyUsageSummary(date: string, currency: string | null = null): UsageLedgerSummary {
  return { date, currency, amountMicros: 0, unpricedCount: 0, byGraphAndKind: {} };
}

export class MemoryUsageLedgerStore implements UsageLedgerStore {
  private readonly partitions = new Map<string, UsageLedgerRecord[]>();
  constructor(private readonly currency: string | null = null, private readonly now: () => number = Date.now) {}

  async append(record: UsageLedgerRecord): Promise<void> {
    const oldest = Date.parse(record.recordedAt) - USAGE_LEDGER_TTL_SECONDS * 1000;
    for (const [date, records] of this.partitions) {
      if (Date.parse(records.at(-1)?.recordedAt ?? "") < oldest) this.partitions.delete(date);
    }
    this.partitions.set(record.date, [...(this.partitions.get(record.date) ?? []), record]);
  }

  records(date: string): readonly UsageLedgerRecord[] {
    const oldest = this.now() - USAGE_LEDGER_TTL_SECONDS * 1000;
    const records = (this.partitions.get(date) ?? []).filter(record => Date.parse(record.recordedAt) > oldest);
    if (records.length) this.partitions.set(date, records); else this.partitions.delete(date);
    return [...records];
  }

  async read(date: string): Promise<UsageLedgerSummary> {
    const records = this.records(date);
    const summary = emptyUsageSummary(date, this.currency ?? records[0]?.currency ?? null);
    for (const record of records) {
      const key = JSON.stringify([record.graphId, record.callKind]);
      const current = summary.byGraphAndKind[key] ?? { graphId: record.graphId, callKind: record.callKind, amountMicros: 0, unpricedCount: 0 };
      summary.byGraphAndKind[key] = { ...current, amountMicros: current.amountMicros + (record.amountMicros ?? 0), unpricedCount: current.unpricedCount + Number(record.status === "unpriced") };
      summary.amountMicros += record.amountMicros ?? 0;
      summary.unpricedCount += Number(record.status === "unpriced");
    }
    return summary;
  }
}

type UsageEvent = "usage_missing" | "usage_ledger_write_failed";
type LedgerWriterOptions = {
  store: UsageLedgerStore;
  prices: PriceTable;
  timeZone: string;
  writeTimeoutMs?: number;
  now?: () => Date;
  observe?: (event: UsageEvent, fields: Record<string, string | number>) => void;
};

export class UsageLedgerWriter {
  private readonly pending = new Set<Promise<void>>();
  private readonly timeoutMs: number;
  private failureCount = 0;
  constructor(private readonly options: LedgerWriterOptions) {
    this.timeoutMs = parseLedgerWriteTimeout(options.writeTimeoutMs?.toString());
    datePartition(new Date(), options.timeZone);
  }
  get failedWrites(): number { return this.failureCount; }

  private observe(event: UsageEvent, usage: ProviderUsage): void {
    try { this.options.observe?.(event, { provider: usage.provider, model: usage.model, callKind: usage.callKind, value: 1 }); }
    catch { /* Telemetry must not affect delivery or create an unhandled rejection. */ }
  }

  record(usage: ProviderUsage, attribution?: UsageAttribution): void {
    try { this.schedule(usage, attribution); }
    catch {
      this.failureCount++;
      this.observe("usage_ledger_write_failed", usage);
    }
  }

  private schedule(usage: ProviderUsage, attribution?: UsageAttribution): void {
    const now = this.options.now?.() ?? new Date();
    if (usage.inputTokens === null || usage.outputTokens === null) this.observe("usage_missing", usage);
    const record: UsageLedgerRecord = {
      ...usage, ...priceUsage(this.options.prices, usage), recordId: randomUUID(), recordedAt: now.toISOString(),
      date: datePartition(now, this.options.timeZone), graphId: attribution?.graphId ?? "unattributed", currency: this.options.prices.currency,
    };
    // Dispatch after the current provider response continuation, with a separate timeout.
    const write = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.options.store.append(record),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("usage_write_timeout")), this.timeoutMs); }),
        ]);
      } catch {
        this.failureCount++;
        this.observe("usage_ledger_write_failed", usage);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  async flush(): Promise<void> { await Promise.all([...this.pending]); }
}
