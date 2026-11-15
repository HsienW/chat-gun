import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryUsageLedgerStore, UsageLedgerWriter, datePartition, parseLedgerWriteTimeout } from "./ledger.js";
import { parsePriceTable } from "./price-table.js";

const prices = parsePriceTable(JSON.stringify([{
  provider: "fixture", model: "model", callKind: "chat", inputPerMillion: "1", outputPerMillion: "2",
  currency: "USD", source: "https://pricing.fixture.test", verifiedAt: "2026-11-02",
}]));
const usage = { provider: "fixture", model: "model", callKind: "chat" as const, inputTokens: 3, outputTokens: 2 };

describe("usage ledger", () => {
  afterEach(() => vi.useRealTimers());

  it("writes every response and partitions by configured timezone without a shared connection", async () => {
    let now = new Date("2026-11-01T15:59:59Z");
    const store = new MemoryUsageLedgerStore("USD", () => now.getTime());
    const writer = new UsageLedgerWriter({ store, prices, timeZone: "Asia/Singapore", now: () => now });
    writer.record(usage, { graphId: "deep_researcher" });
    writer.record(usage, { graphId: "deep_researcher" });
    await writer.flush();
    expect(await store.read("2026-11-01")).toMatchObject({ currency: "USD", amountMicros: 14, unpricedCount: 0 });
    expect(store.records("2026-11-01")).toHaveLength(2);
    expect(store.records("2026-11-01").map(r => r.graphId)).toEqual(["deep_researcher", "deep_researcher"]);
    now = new Date("2026-11-01T16:00:00Z");
    writer.record(usage);
    await writer.flush();
    expect(datePartition(now, "Asia/Singapore")).toBe("2026-11-02");
    expect(await store.read("2026-11-02")).toMatchObject({ amountMicros: 7 });
    expect(store.records("2026-11-02")[0].graphId).toBe("unattributed");
    now = new Date("2026-11-03T16:00:00Z");
    expect(await store.read("2026-11-02")).toMatchObject({ currency: "USD", amountMicros: 0 });
  });

  it("never delays response delivery while a store hangs and counts failures", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const writer = new UsageLedgerWriter({ prices, timeZone: "Asia/Singapore", writeTimeoutMs: 50,
      store: { append: () => new Promise(() => {}), read: async () => { throw new Error("unused"); } },
      observe: event => { observed.push(event); },
    });
    expect(writer.record(usage)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    await writer.flush();
    expect(observed).toEqual(["usage_ledger_write_failed"]);
    expect(writer.failedWrites).toBe(1);
  });

  it("records missing usage as unpriced and absorbs a write failure", async () => {
    const observed: string[] = [];
    const store = new MemoryUsageLedgerStore();
    const writer = new UsageLedgerWriter({ store, prices, timeZone: "Asia/Singapore", observe: event => { observed.push(event); } });
    writer.record({ ...usage, inputTokens: null, outputTokens: null });
    await writer.flush();
    const summary = await store.read(datePartition(new Date(), "Asia/Singapore"));
    expect(summary).toMatchObject({ amountMicros: 0, unpricedCount: 1 });
    expect(observed).toEqual(["usage_missing"]);
    const failing = new UsageLedgerWriter({ prices, timeZone: "Asia/Singapore", observe: event => { observed.push(event); },
      store: { append: async () => { throw new Error("fixture failure"); }, read: store.read.bind(store) } });
    failing.record(usage);
    await failing.flush();
    expect(failing.failedWrites).toBe(1);
    expect(observed.at(-1)).toBe("usage_ledger_write_failed");
  });

  describe("usageMissingReason (model-usage-ledger delta)", () => {
    const estimating = parsePriceTable(JSON.stringify([{
      provider: "fixture", model: "model", callKind: "chat", inputPerMillion: "1", outputPerMillion: "2",
      currency: "USD", source: "https://pricing.fixture.test", verifiedAt: "2026-11-02", missingUsageEstimateMicros: 9,
    }]));

    async function recordWith(entry: Parameters<UsageLedgerWriter["record"]>[0], table = prices) {
      const observed: Array<{ event: string; fields: Record<string, string | number> }> = [];
      const store = new MemoryUsageLedgerStore("USD");
      const writer = new UsageLedgerWriter({ store, prices: table, timeZone: "UTC", observe: (event, fields) => { observed.push({ event, fields }); } });
      writer.record(entry);
      await writer.flush();
      const date = datePartition(new Date(), "UTC");
      return { observed, summary: await store.read(date), records: store.records(date) };
    }

    const missing = { ...usage, inputTokens: null, outputTokens: null };

    it("carries the reason on usage_missing without changing pricing, totals or the stored record", async () => {
      const withReason = await recordWith({ ...missing, usageMissingReason: "stream_aborted" }, estimating);
      const without = await recordWith(missing, estimating);

      expect(withReason.observed).toEqual([{ event: "usage_missing", fields: { provider: "fixture", model: "model", callKind: "chat", value: 1, reason: "stream_aborted" } }]);
      expect(without.observed).toEqual([{ event: "usage_missing", fields: { provider: "fixture", model: "model", callKind: "chat", value: 1 } }]);
      expect(withReason.summary).toEqual(without.summary);
      expect(withReason.records[0]).toMatchObject({ status: "estimated", amountMicros: 9 });
      expect(withReason.records[0]).not.toHaveProperty("usageMissingReason");
    });

    it("keeps unpriced counting identical with usage_frame_missing", async () => {
      const result = await recordWith({ ...missing, usageMissingReason: "usage_frame_missing" });
      expect(result.summary).toMatchObject({ amountMicros: 0, unpricedCount: 1 });
      expect(result.observed[0]?.fields.reason).toBe("usage_frame_missing");
    });

    it("reports an out-of-set reason as unknown and still meters", async () => {
      const result = await recordWith({ ...missing, usageMissingReason: "socket_reset" as never });
      expect(result.observed).toEqual([expect.objectContaining({ event: "usage_missing", fields: expect.objectContaining({ reason: "unknown" }) })]);
      expect(result.records).toHaveLength(1);
    });

    it("ignores a reason when usage is complete", async () => {
      const result = await recordWith({ ...usage, usageMissingReason: "stream_aborted" });
      expect(result.observed).toEqual([]);
      expect(result.records[0]).toMatchObject({ status: "priced", amountMicros: 7 });
      expect(result.records[0]).not.toHaveProperty("usageMissingReason");
    });
  });

  it("validates write timeout bounds", () => {
    expect(parseLedgerWriteTimeout()).toBe(1000);
    expect(parseLedgerWriteTimeout("50")).toBe(50);
    expect(parseLedgerWriteTimeout("5000")).toBe(5000);
    for (const value of ["0", "49", "5001", "invalid", "50.5"]) expect(() => parseLedgerWriteTimeout(value)).toThrow(/USAGE_LEDGER_WRITE_TIMEOUT_MS/);
  });

  it("absorbs a synchronous pricing overflow without failing the model response", async () => {
    const observed: string[] = [];
    const writer = new UsageLedgerWriter({ store: new MemoryUsageLedgerStore(), prices, timeZone: "UTC", observe: event => { observed.push(event); } });
    expect(() => writer.record({ ...usage, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER })).not.toThrow();
    await writer.flush();
    expect(writer.failedWrites).toBe(1);
    expect(observed).toEqual(["usage_ledger_write_failed"]);
  });
});
