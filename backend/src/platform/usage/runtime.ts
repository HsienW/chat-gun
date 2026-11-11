import { Redis } from "ioredis";
import { recordMetric } from "../observability.js";
import { MemoryUsageLedgerStore, UsageLedgerWriter, datePartition, parseLedgerWriteTimeout } from "./ledger.js";
import { parsePriceTable, type ProviderUsage, type UsageCallKind } from "./price-table.js";
import { RedisUsageLedgerStore, type UsageLedgerMetadata } from "./redis-store.js";
import type { ModelPurpose } from "../llm-gateway.js";
import type { UsageAttribution } from "./attribution.js";

export function callKindForPurpose(purpose: ModelPurpose | string): UsageCallKind {
  if (purpose === "vision") return "vision";
  if (!["chat", "math", "research", "tool"].includes(purpose)) {
    void recordMetric("usage_unknown_model_purpose", { purpose });
  }
  return "chat";
}

function readUsageConfiguration(env: NodeJS.ProcessEnv) {
  const prices = parsePriceTable(env.USAGE_PRICE_TABLE_JSON);
  const timeZone = env.USAGE_LEDGER_TIME_ZONE?.trim() || "UTC";
  try { datePartition(new Date(), timeZone); }
  catch { throw new Error("invalid_configuration:USAGE_LEDGER_TIME_ZONE"); }
  const writeTimeoutMs = parseLedgerWriteTimeout(env.USAGE_LEDGER_WRITE_TIMEOUT_MS);
  const keyPrefix = env.USAGE_LEDGER_KEY_PREFIX?.trim() || "usage-ledger";
  const uri = env.USAGE_LEDGER_REDIS_URI?.trim();
  if (uri) {
    try { if (!["redis:", "rediss:"].includes(new URL(uri).protocol)) throw new Error(); }
    catch { throw new Error("invalid_configuration:USAGE_LEDGER_REDIS_URI"); }
  }
  return { prices, timeZone, writeTimeoutMs, keyPrefix, uri };
}

export function createUsageRuntime(env: NodeJS.ProcessEnv = process.env) {
  const settings = readUsageConfiguration(env);
  // Lazy connection: importing the general gateway never connects without configured storage.
  const redis = settings.uri ? new Redis(settings.uri, {
    lazyConnect: true, connectTimeout: settings.writeTimeoutMs, maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  }) : undefined;
  redis?.on("error", () => { /* Writer/readiness reports safe, stable failures without connection details. */ });
  const metadata: UsageLedgerMetadata = { version: "usage-ledger@1", currency: settings.prices.currency, timeZone: settings.timeZone, keyPrefix: settings.keyPrefix };
  const store = redis ? new RedisUsageLedgerStore(redis, metadata) : new MemoryUsageLedgerStore(settings.prices.currency);
  const writer = new UsageLedgerWriter({ ...settings, store,
    observe: (event, fields) => { void recordMetric(event, fields).catch(() => undefined); },
  });
  return { ...settings, metadata, store, writer, isShared: redis !== undefined,
    async ready(): Promise<boolean> {
      if (!redis || !(store instanceof RedisUsageLedgerStore)) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            if (redis.status === "wait" || redis.status === "end") await redis.connect();
            await store.initialize();
          })(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("usage_storage_timeout")), settings.writeTimeoutMs); }),
        ]);
        return true;
      } catch { return false; }
      finally { if (timer) clearTimeout(timer); }
    },
    async close() { await writer.flush(); redis?.disconnect(); },
  };
}

let runtime: ReturnType<typeof createUsageRuntime> | undefined;
export function getUsageRuntime(): ReturnType<typeof createUsageRuntime> { return runtime ??= createUsageRuntime(); }

/** Called once per actual provider response, before cancellation/format validation. */
export function recordProviderUsage(usage: ProviderUsage, attribution?: UsageAttribution): void {
  getUsageRuntime().writer.record(usage, attribution);
}
