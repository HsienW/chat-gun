import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { requestsForRun } from "../run-admission.js";
import { SharedUsageLedgerReader, ledgerDate, nextLedgerDate, type UsageSnapshot } from "../usage-ledger-reader.js";
import { composeApplicationProfile } from "../application-profile.js";
import { DemoAdmissionPolicy, type DemoAdmissionStore } from "./admission-policy.js";
import { DEMO_GRAPHS, readDemoSettings } from "./config.js";
import { VISITOR_COOKIE, VisitorSessionResolver } from "./visitor-session.js";

const now = Date.parse("2026-11-02T12:00:00Z");
const metadata = { version: "usage-ledger@1" as const, currency: "USD", timeZone: "Asia/Singapore", keyPrefix: "fixture-usage" };
function environment(): NodeJS.ProcessEnv {
  return { DEMO_ENABLED: "true", BFF_ALLOWED_ORIGINS: "https://app.example.test", BFF_TRUSTED_PROXIES: "",
    USAGE_LEDGER_REDIS_URI: "redis://127.0.0.1:6379", USAGE_LEDGER_KEY_PREFIX: metadata.keyPrefix, USAGE_LEDGER_TIME_ZONE: metadata.timeZone,
    DEMO_BUDGET_CURRENCY: "USD", DEMO_SESSION_SECRET: "test-fixture-signature-32-bytes-long", DEMO_SESSION_LIFETIME_MS: "3600000",
    DEMO_LEASE_TTL_MS: "150000", BFF_UPSTREAM_TIMEOUT_MS: "120000", DEMO_BUDGET_TIMEOUT_MS: "500",
    DEMO_CONCURRENCY_LIMIT: "3", DEMO_RESEARCH_IP_DAILY_RUNS: "2",
    DEMO_BUDGETS_JSON: JSON.stringify({ site: 210000, gun_chat: 28000, gun_shop: 125000, deep_research: 42000, reserve: 14000 }),
    DEMO_GRAPH_BUDGETS_JSON: JSON.stringify({ chatbot: "gun_chat", shopping_assistant: "gun_shop", deep_researcher: "deep_research" }),
    BFF_RATE_LIMIT_USER_MAX_REQUESTS: "30", BFF_RATE_LIMIT_USER_WINDOW_MS: "60000", BFF_RATE_LIMIT_IP_MAX_REQUESTS: "60", BFF_RATE_LIMIT_IP_WINDOW_MS: "60000" };
}
function settings(env = environment()) { const config = loadConfig(); config.allowedOrigins = ["https://app.example.test"]; return readDemoSettings(env, config); }
const snapshot = (): UsageSnapshot => ({ date: ledgerDate(now, metadata.timeZone), resetAt: nextLedgerDate(now, metadata.timeZone), currency: "USD", amountMicros: 0, unpricedCount: 0, items: [] });
function request(graph: string = DEMO_GRAPHS.chat, path = "/runs/stream", body: Record<string, unknown> = {}) {
  return requestsForRun("POST", path, Buffer.from(JSON.stringify({ assistant_id: graph, on_disconnect: "cancel", ...body })), { subject: "visitor", clientIp: "203.0.113.1" })[0];
}
class Store implements DemoAdmissionStore {
  leases = new Map<string, number>(); quotas = new Map<string, number>(); releases = 0;
  async acquire(input: Parameters<DemoAdmissionStore["acquire"]>[0]) {
    for (const [id, expiry] of this.leases) if (expiry <= input.now) this.leases.delete(id);
    if (input.quotaLimit && (this.quotas.get(input.quotaKey) ?? 0) >= input.quotaLimit) return "quota" as const;
    if (this.leases.size >= input.concurrency) return "concurrency" as const;
    this.leases.set(input.id, input.expiresAt);
    if (input.quotaLimit) this.quotas.set(input.quotaKey, (this.quotas.get(input.quotaKey) ?? 0) + 1);
    return "allow" as const;
  }
  async release(id: string) { this.releases++; this.leases.delete(id); }
}

describe("Demo strict settings", () => {
  it("requires every setting; errors never contain the supplied secret", () => {
    for (const key of Object.keys(environment()).filter(key => key !== "DEMO_ENABLED")) {
      const env = environment(); delete env[key]; expect(() => settings(env), key).toThrow(`invalid_configuration:${key}`);
    }
    const env = environment(); env.DEMO_SESSION_SECRET = "sensitive-fixture";
    expect(() => settings(env)).toThrow(/^invalid_configuration:DEMO_SESSION_SECRET$/u);
  });
  it("accepts explicit empty proxy keys and both grace endpoints, rejects unsafe values", () => {
    for (const ttl of [150000, 240000]) expect(settings({ ...environment(), DEMO_LEASE_TTL_MS: String(ttl) }).leaseTtlMs).toBe(ttl);
    for (const ttl of [149999, 240001]) expect(() => settings({ ...environment(), DEMO_LEASE_TTL_MS: String(ttl) })).toThrow("DEMO_LEASE_TTL_MS");
    for (const value of ["0", "-1", "NaN", "1.2"]) expect(() => settings({ ...environment(), DEMO_CONCURRENCY_LIMIT: value })).toThrow("DEMO_CONCURRENCY_LIMIT");
    expect(() => settings({ ...environment(), DEMO_BUDGETS_JSON: JSON.stringify({ site: 1, gun_chat: 1, gun_shop: 1, deep_research: 1, reserve: 1 }) })).toThrow("DEMO_BUDGETS_JSON");
    const config = loadConfig(); config.allowedOrigins = ["*"];
    expect(() => readDemoSettings(environment(), config)).toThrow("BFF_ALLOWED_ORIGINS");
    expect(() => settings({ ...environment(), DEMO_GRAPH_BUDGETS_JSON: '{"math_agent":"gun_chat"}' })).toThrow("DEMO_GRAPH_BUDGETS_JSON");
    expect(composeApplicationProfile(loadConfig(), { DEMO_ENABLED: "false" })).toEqual({});
    expect(() => composeApplicationProfile(loadConfig(), { DEMO_ENABLED: "yes" })).toThrow("DEMO_ENABLED");
  });
});

describe("anonymous visitor cookies", () => {
  it("signs exactly three fields and reuses a same-site session without changing principal", () => {
    const resolver = new VisitorSessionResolver(environment().DEMO_SESSION_SECRET!, 3600000, () => now);
    const first = resolver.resolve({ principalId: "anonymous" });
    expect(first.setCookie).toContain("HttpOnly; Secure; SameSite=Strict");
    const cookie = first.setCookie!.split(";")[0];
    const payload = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["expiresAt", "issuedAt", "sessionId"]);
    expect(resolver.resolve({ principalId: "anonymous", cookie })).toEqual({ subject: first.subject });
    expect(resolver.resolve({ principalId: "anonymous" }).subject).not.toBe(first.subject);
  });
  it("rotates tampered and expired cookies without logging their values", () => {
    const secret = environment().DEMO_SESSION_SECRET!;
    const cookie = new VisitorSessionResolver(secret, 1000, () => now).resolve({ principalId: "anonymous" }).setCookie!.split(";")[0];
    const resolver = new VisitorSessionResolver(secret, 1000, () => now + 1001);
    expect(resolver.resolve({ principalId: "anonymous", cookie }).event).toBe("visitor_session_expired");
    expect(resolver.resolve({ principalId: "anonymous", cookie: `${VISITOR_COOKIE}=tampered.signature` }).event).toBe("visitor_session_invalid");
  });
});

describe("readonly shared ledger", () => {
  function reader(changes: Record<string, unknown> = {}, fields: Record<string, string> = {}) {
    return new SharedUsageLedgerReader({ expected: metadata, timeoutMs: 50, now: () => now,
      redis: { get: async () => JSON.stringify(metadata), hgetall: async () => fields },
      backendMetadata: async () => ({ ...metadata, ready: true, shared: true, pricesComplete: true, ...changes }) });
  }
  it("reports the ledger currency and exact totals without writing", async () => {
    const fields = { amountMicros: "3", unpricedCount: "0", 'amount:["chatbot","chat"]': "3" };
    expect(await reader({}, fields).read()).toMatchObject({ currency: "USD", amountMicros: 3, items: [{ graphId: "chatbot", callKind: "chat", amountMicros: 3 }] });
    expect(nextLedgerDate(now, "Asia/Singapore")).toBe(Date.parse("2026-11-02T16:00:00Z"));
    expect(nextLedgerDate(Date.parse("2026-03-08T06:00:00Z"), "America/New_York")).toBe(Date.parse("2026-03-09T04:00:00Z"));
  });
  it.each([{ currency: "CNY" }, { timeZone: "UTC" }, { keyPrefix: "wrong" }, { ready: false }, { pricesComplete: false }, { shared: false }])("fails closed for %j", async changes => {
    await expect(reader(changes).read()).rejects.toThrow("usage_budget_unavailable");
  });
  it("fails closed on unpriced, malformed and timed-out snapshots", async () => {
    await expect(reader({}, { unpricedCount: "1" }).read()).rejects.toThrow("usage_budget_unavailable");
    await expect(reader({}, { amountMicros: "-1" }).read()).rejects.toThrow("usage_budget_unavailable");
    vi.useFakeTimers();
    try {
      const pending = new SharedUsageLedgerReader({ expected: metadata, timeoutMs: 50,
        redis: { get: () => new Promise(() => {}), hgetall: async () => ({}) }, backendMetadata: async () => ({}) }).read();
      const assertion = expect(pending).rejects.toThrow("usage_budget_unavailable");
      await vi.advanceTimersByTimeAsync(50); await assertion;
    } finally { vi.useRealTimers(); }
  });
});

describe("Demo admission", () => {
  it("enforces site/scope limits, reserve only contributes to site, resume skips budget/quota", async () => {
    const usage = snapshot(), store = new Store(), read = vi.fn(async () => usage);
    const policy = new DemoAdmissionPolicy(settings(), { read }, store, () => now);
    usage.amountMicros = 210000;
    expect(await policy.check(request())).toMatchObject({ code: "usage_budget_exhausted", budgetScope: "site", retryAfterSeconds: 14400 });
    usage.amountMicros = 42000; usage.items = [{ graphId: DEMO_GRAPHS.research, callKind: "chat", amountMicros: 42000, unpricedCount: 0 }];
    expect(await policy.check(request(DEMO_GRAPHS.research))).toMatchObject({ code: "usage_budget_exhausted", budgetScope: "deep_research" });
    expect(await policy.check(request())).toMatchObject({ kind: "allow" });
    usage.items = [{ graphId: DEMO_GRAPHS.chat, callKind: "vision", amountMicros: 42000, unpricedCount: 0 }];
    expect(await policy.check(request())).toMatchObject({ kind: "allow" });
    read.mockRejectedValue(new Error("offline"));
    expect(await policy.check(request())).toMatchObject({ code: "usage_budget_unavailable" });
    expect(await policy.check(request(DEMO_GRAPHS.shop, "/runs/wait", { command: { resume: true } }))).toMatchObject({ kind: "allow" });
  });
  it("checks features before storage and refuses every unsafe lifecycle/path", async () => {
    const read = vi.fn(async () => snapshot()), store = new Store();
    const policy = new DemoAdmissionPolicy(settings(), { read }, store, () => now);
    const cases = [request("math_agent"), request("mcp_agent"), request("toString"), request(DEMO_GRAPHS.chat, "/runs"),
      request(DEMO_GRAPHS.chat, "/runs/batch"), request(DEMO_GRAPHS.chat, "/crons"), request(DEMO_GRAPHS.shop, "/runs", { command: { resume: true } }),
      request(DEMO_GRAPHS.chat, "/runs/stream", { on_disconnect: "continue" }), request(DEMO_GRAPHS.chat, "/runs/stream", { after_seconds: 0 }),
      request(DEMO_GRAPHS.chat, "/runs/stream", { stream_resumable: true }),
      requestsForRun("POST", "/runs/stream", Buffer.from('{"assistant_id":"chatbot"}'), { subject: "visitor", clientIp: "ip" })[0],
      requestsForRun("POST", "/runs/stream", Buffer.from("invalid"), { subject: "visitor", clientIp: "ip" })[0]];
    for (const value of cases) expect(await policy.check(value)).toEqual({ kind: "deny", code: "feature_disabled" });
    expect(read).not.toHaveBeenCalled(); expect(store.leases.size).toBe(0);
  });
  it("increments per-IP quota only on allow, separates IPs, releases once and expires crashed leases", async () => {
    let clock = now;
    const store = new Store(), policy = new DemoAdmissionPolicy(settings(), { read: async () => snapshot() }, store, () => clock);
    for (let i = 0; i < 2; i++) {
      const result = await policy.check(request(DEMO_GRAPHS.research)); expect(result.kind).toBe("allow");
      if (result.kind === "allow") { await result.lease?.release(); await result.lease?.release(); }
    }
    expect(store.releases).toBe(2);
    expect(await policy.check(request(DEMO_GRAPHS.research))).toMatchObject({ code: "run_quota_exhausted" });
    const other = request(DEMO_GRAPHS.research); other.clientIp = "203.0.113.2";
    expect(await policy.check(other)).toMatchObject({ kind: "allow" });
    for (let i = 0; i < 2; i++) expect(await policy.check(request())).toMatchObject({ kind: "allow" });
    expect(await policy.check(request())).toMatchObject({ code: "run_concurrency_limited" });
    clock += settings().leaseTtlMs - 1;
    expect(await policy.check(request())).toMatchObject({ code: "run_concurrency_limited" });
    clock++;
    expect(await policy.check(request())).toMatchObject({ kind: "allow" });
  });
});
