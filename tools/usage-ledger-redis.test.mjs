import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MemoryUsageLedgerStore, UsageLedgerWriter } from "../backend/src/platform/usage/ledger.ts";
import { parsePriceTable } from "../backend/src/platform/usage/price-table.ts";
import { RedisUsageLedgerStore } from "../backend/src/platform/usage/redis-store.ts";
import { SharedUsageLedgerReader } from "../bff/src/usage-ledger-reader.ts";
import { RedisDemoAdmissionStore } from "../bff/src/demo/admission-policy.ts";

const { Redis } = createRequire(new URL("../backend/package.json", import.meta.url))("ioredis");
const uri = process.env.USAGE_TEST_REDIS_URI;
if (!uri) throw new Error("USAGE_TEST_REDIS_URI must identify an isolated test Redis");

test("real Redis ledger initializes empty, agrees with readonly BFF, partitions dates and retains 48h", async () => {
  const redis = new Redis(uri, { maxRetriesPerRequest: 0 });
  const prefix = `usage-test:${randomUUID()}`;
  const metadata = { version: "usage-ledger@1", keyPrefix: prefix, currency: "USD", timeZone: "Asia/Singapore" };
  const keys = [`${prefix}:metadata`, ...["2026-11-01", "2026-11-02"].flatMap(date => [`${prefix}:daily:${date}`, `${prefix}:records:${date}`])];
  try {
    const store = new RedisUsageLedgerStore(redis, metadata);
    await store.initialize();
    let now = new Date("2026-11-01T15:59:59Z");
    const calls = [];
    const reader = new SharedUsageLedgerReader({ expected: metadata, timeoutMs: 1000, now: () => now.getTime(),
      redis: { get: key => { calls.push("GET"); return redis.get(key); }, hgetall: key => { calls.push("HGETALL"); return redis.hgetall(key); } },
      backendMetadata: async () => ({ ...metadata, ready: true, shared: true, pricesComplete: true }),
    });
    assert.equal((await reader.read()).currency, "USD");
    assert.equal((await reader.read()).amountMicros, 0);
    const prices = parsePriceTable(JSON.stringify([{ provider: "fixture", model: "fixture", callKind: "chat", currency: "USD", inputPerMillion: "0.1", outputPerMillion: "0.2", source: "https://example.test/fixture", verifiedAt: "2026-11-02" }]));
    const memory = new MemoryUsageLedgerStore("USD", () => now.getTime());
    const sharedWriter = new UsageLedgerWriter({ store, prices, timeZone: metadata.timeZone, now: () => now });
    const memoryWriter = new UsageLedgerWriter({ store: memory, prices, timeZone: metadata.timeZone, now: () => now });
    for (let i = 0; i < 3; i++) for (const writer of [sharedWriter, memoryWriter]) writer.record({ provider: "fixture", model: "fixture", callKind: "chat", inputTokens: 3, outputTokens: 2 }, { graphId: "chatbot" });
    await Promise.all([sharedWriter.flush(), memoryWriter.flush()]);
    assert.equal(sharedWriter.failedWrites, 0);
    const snapshot = await reader.read();
    assert.equal(snapshot.amountMicros, 3);
    assert.equal(snapshot.amountMicros, (await memory.read("2026-11-01")).amountMicros);
    assert.deepEqual(snapshot.items, Object.values((await store.read("2026-11-01")).byGraphAndKind));
    assert.ok((await redis.ttl(`${prefix}:daily:2026-11-01`)) > 172790);
    now = new Date("2026-11-01T16:00:00Z");
    assert.equal((await reader.read()).amountMicros, 0);
    assert.equal((await reader.read()).date, "2026-11-02");
    sharedWriter.record({ provider: "fixture", model: "missing", callKind: "chat", inputTokens: 3, outputTokens: 2 }); await sharedWriter.flush();
    await assert.rejects(reader.read(), /usage_budget_unavailable/u);
    assert.deepEqual([...new Set(calls)].sort(), ["GET", "HGETALL"]);
  } finally { await redis.del(...keys); redis.disconnect(); }
});

test("real Redis admission Lua atomically caps concurrency and successful daily quotas", async () => {
  const redis = new Redis(uri, { maxRetriesPerRequest: 0 });
  const prefix = `admission-test:${randomUUID()}`;
  const store = new RedisDemoAdmissionStore(redis, prefix);
  const now = Date.now();
  const input = { now, expiresAt: now + 60000, quotaKey: "fixture", quotaLimit: 0, resetAt: now + 86400000, concurrency: 3 };
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.acquire({ ...input, id: `run-${i}` })));
    assert.equal(results.filter(result => result === "allow").length, 3);
    assert.equal(await redis.zcard(`${prefix}:leases`), 3);
    await store.release("run-0");
    assert.equal(await store.acquire({ ...input, id: "replacement" }), "allow");
    assert.equal(await store.acquire({ ...input, id: "blocked" }), "concurrency");
    assert.equal(await store.acquire({ ...input, now: input.expiresAt, expiresAt: input.expiresAt + 60000, id: "after-crash" }), "allow");
    await store.release("after-crash");
    for (let i = 0; i < 2; i++) {
      assert.equal(await store.acquire({ ...input, quotaLimit: 2, id: `research-${i}` }), "allow");
      await store.release(`research-${i}`);
    }
    assert.equal(await store.acquire({ ...input, quotaLimit: 2, id: "research-blocked" }), "quota");
    assert.equal(await redis.get(`${prefix}:quota:fixture`), "2");
  } finally { await redis.del(`${prefix}:leases`, `${prefix}:quota:fixture`); redis.disconnect(); }
});
