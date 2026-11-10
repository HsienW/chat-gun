import { createHash, randomUUID } from "node:crypto";
import type { RunAdmissionDecision, RunAdmissionPolicy, RunAdmissionRequest } from "../run-admission.js";
import { ledgerDate, nextLedgerDate, type UsageLedgerReader } from "../usage-ledger-reader.js";
import { DEMO_GRAPHS, type DemoSettings } from "./config.js";

export interface DemoAdmissionStore {
  acquire(input: { id: string; now: number; expiresAt: number; quotaKey: string; quotaLimit: number; resetAt: number; concurrency: number }): Promise<"allow" | "quota" | "concurrency">;
  release(id: string): Promise<void>;
}
export interface AdmissionRedisPort { eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>; }
export const ACQUIRE_DEMO_LEASE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if tonumber(ARGV[5]) > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[5]) then return 'quota' end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 'concurrency' end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) - tonumber(ARGV[1]))
if tonumber(ARGV[5]) > 0 then
  redis.call('INCR', KEYS[2])
  redis.call('PEXPIREAT', KEYS[2], ARGV[6])
end
return 'allow'`;

export class RedisDemoAdmissionStore implements DemoAdmissionStore {
  constructor(private readonly redis: AdmissionRedisPort, private readonly prefix: string) {}
  async acquire(input: Parameters<DemoAdmissionStore["acquire"]>[0]): Promise<"allow" | "quota" | "concurrency"> {
    const result = await this.redis.eval(ACQUIRE_DEMO_LEASE_LUA, 2, `${this.prefix}:leases`, `${this.prefix}:quota:${input.quotaKey}`,
      input.now, input.expiresAt, input.id, input.concurrency, input.quotaLimit, input.resetAt);
    if (result !== "allow" && result !== "quota" && result !== "concurrency") throw new Error("usage_budget_unavailable");
    return result;
  }
  async release(id: string): Promise<void> {
    await this.redis.eval("return redis.call('ZREM', KEYS[1], ARGV[1])", 1, `${this.prefix}:leases`, id);
  }
}

export class DemoAdmissionPolicy implements RunAdmissionPolicy {
  constructor(private readonly settings: DemoSettings, private readonly reader: UsageLedgerReader, private readonly store: DemoAdmissionStore,
    private readonly now: () => number = Date.now) {}

  async check(request: RunAdmissionRequest): Promise<RunAdmissionDecision> {
    const { lifecycle } = request;
    const scope = request.graphId && Object.hasOwn(this.settings.graphs, request.graphId) ? this.settings.graphs[request.graphId] : undefined;
    if (!["stream", "wait"].includes(request.routeKind) || !scope
      || lifecycle.onDisconnect.state !== "present" || lifecycle.onDisconnect.value !== "cancel"
      || lifecycle.afterSeconds.state !== "absent" || lifecycle.streamResumable.state === "unparseable"
      || (lifecycle.streamResumable.state === "present" && lifecycle.streamResumable.value !== false)) return { kind: "deny", code: "feature_disabled" };
    const now = this.now(), resetAt = nextLedgerDate(now, this.settings.timeZone);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    try {
      if (request.signal?.aborted) throw new Error("admission_cancelled");
      if (!request.isResume) {
        const usage = await this.reader.read(request.signal);
        if (usage.currency !== this.settings.currency || usage.unpricedCount > 0) throw new Error("usage_budget_unavailable");
        if (usage.amountMicros >= this.settings.budgets.site) return { kind: "deny", code: "usage_budget_exhausted", budgetScope: "site", retryAfterSeconds };
        // Non-chat calls are the reserve: included in total, never an independent denial.
        const amount = usage.items.filter(item => item.callKind === "chat" && this.settings.graphs[item.graphId] === scope)
          .reduce((sum, item) => sum + item.amountMicros, 0);
        if (amount >= this.settings.budgets[scope]) return { kind: "deny", code: "usage_budget_exhausted", budgetScope: scope, retryAfterSeconds };
      }
      if (request.signal?.aborted) throw new Error("admission_cancelled");
      const id = randomUUID(), acquiredAt = this.now(), expiresAt = acquiredAt + this.settings.leaseTtlMs;
      const quotaKey = `${ledgerDate(now, this.settings.timeZone)}:${createHash("sha256").update(request.clientIp).digest("hex")}`;
      const result = await this.store.acquire({ id, now: this.now(), expiresAt, quotaKey, resetAt,
        quotaLimit: !request.isResume && request.graphId === DEMO_GRAPHS.research ? this.settings.dailyIpRuns : 0, concurrency: this.settings.concurrency });
      if (result === "quota") return { kind: "deny", code: "run_quota_exhausted", retryAfterSeconds };
      if (result === "concurrency") return { kind: "deny", code: "run_concurrency_limited", retryAfterSeconds: Math.max(1, Math.ceil(this.settings.leaseTtlMs / 1000)) };
      let released = false;
      const lease = { acquiredAt, expiresAt, release: async () => { if (!released) { released = true; await this.store.release(id); } } };
      if (request.signal?.aborted) { await lease.release(); return { kind: "deny", code: "usage_budget_unavailable" }; }
      return { kind: "allow", lease };
    } catch { return { kind: "deny", code: "usage_budget_unavailable" }; }
  }
}
