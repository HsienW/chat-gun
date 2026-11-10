import { z } from "zod";
import { USAGE_CALL_KINDS } from "./price-table.js";
import { USAGE_LEDGER_TTL_SECONDS, emptyUsageSummary, type UsageLedgerRecord, type UsageLedgerStore, type UsageLedgerSummary } from "./ledger.js";

export const USAGE_LEDGER_WIRE_VERSION = "usage-ledger@1";
export type UsageLedgerMetadata = {
  version: typeof USAGE_LEDGER_WIRE_VERSION;
  currency: string | null;
  timeZone: string;
  keyPrefix: string;
};
export interface UsageRedisPort {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

// Backend owns writes. BFF only needs GET and HGETALL on this wire contract.
export const APPEND_USAGE_LUA = `
local expected = ARGV[1]
local metadata = redis.call('GET', KEYS[1])
if metadata and metadata ~= expected then return redis.error_reply('usage_metadata_mismatch') end
redis.call('SET', KEYS[1], expected, 'EX', ARGV[7])
redis.call('HINCRBY', KEYS[2], 'amountMicros', ARGV[2])
redis.call('HINCRBY', KEYS[2], 'unpricedCount', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'amount:' .. ARGV[4], ARGV[2])
redis.call('HINCRBY', KEYS[2], 'unpriced:' .. ARGV[4], ARGV[3])
redis.call('RPUSH', KEYS[3], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[7])
return 1
`;

export function ledgerMetadataKey(prefix: string): string { return `${prefix}:metadata`; }
export function ledgerDailyKey(prefix: string, date: string): string { return `${prefix}:daily:${date}`; }

function nonnegativeInteger(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsed)) throw new Error("invalid_usage_ledger_snapshot");
  return parsed;
}

export function parseUsageSnapshot(date: string, currency: string | null, fields: Record<string, string>): UsageLedgerSummary {
  const summary = emptyUsageSummary(date, currency);
  summary.amountMicros = nonnegativeInteger(fields.amountMicros);
  summary.unpricedCount = nonnegativeInteger(fields.unpricedCount);
  for (const field of Object.keys(fields)) {
    if (!field.startsWith("amount:")) continue;
    const key = field.slice("amount:".length);
    const [graphId, callKind] = z.tuple([z.string().min(1), z.enum(USAGE_CALL_KINDS)]).parse(JSON.parse(key));
    summary.byGraphAndKind[key] = { graphId, callKind, amountMicros: nonnegativeInteger(fields[field]), unpricedCount: nonnegativeInteger(fields[`unpriced:${key}`]) };
  }
  return summary;
}

export class RedisUsageLedgerStore implements UsageLedgerStore {
  readonly metadata: UsageLedgerMetadata;
  constructor(private readonly redis: UsageRedisPort, options: Omit<UsageLedgerMetadata, "version">) {
    this.metadata = { version: USAGE_LEDGER_WIRE_VERSION, currency: options.currency, timeZone: options.timeZone, keyPrefix: options.keyPrefix };
  }

  async initialize(): Promise<void> {
    const result = await this.redis.eval(`
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return redis.error_reply('usage_metadata_mismatch') end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`, 1, ledgerMetadataKey(this.metadata.keyPrefix), JSON.stringify(this.metadata), USAGE_LEDGER_TTL_SECONDS);
    if (result !== 1) throw new Error("usage_ledger_initialize_failed");
  }

  async append(record: UsageLedgerRecord): Promise<void> {
    const prefix = this.metadata.keyPrefix;
    const result = await this.redis.eval(APPEND_USAGE_LUA, 3,
      ledgerMetadataKey(prefix), ledgerDailyKey(prefix, record.date), `${prefix}:records:${record.date}`,
      JSON.stringify(this.metadata), record.amountMicros ?? 0, Number(record.status === "unpriced"),
      JSON.stringify([record.graphId, record.callKind]), JSON.stringify(record), record.date, USAGE_LEDGER_TTL_SECONDS);
    if (result !== 1) throw new Error("usage_ledger_append_failed");
  }

  async read(date: string): Promise<UsageLedgerSummary> {
    const metadata = await this.redis.get(ledgerMetadataKey(this.metadata.keyPrefix));
    if (metadata !== JSON.stringify(this.metadata)) throw new Error("usage_metadata_mismatch");
    return parseUsageSnapshot(date, this.metadata.currency, await this.redis.hgetall(ledgerDailyKey(this.metadata.keyPrefix, date)));
  }
}
