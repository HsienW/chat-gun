import type { BffConfig } from "../config.js";
import { parseTrustedProxies } from "../client-ip.js";
import { ledgerDate } from "../usage-ledger-reader.js";

export const DEMO_GRAPHS = Object.freeze({ chat: "chatbot", shop: "shopping_assistant", research: "deep_researcher" });
export const DEMO_SCOPES = ["gun_chat", "gun_shop", "deep_research", "reserve"] as const;
export type DemoSettings = {
  redisUri: string; keyPrefix: string; timeZone: string; currency: string; timeoutMs: number;
  sessionSecret: string; sessionLifetimeMs: number; leaseTtlMs: number; concurrency: number; dailyIpRuns: number;
  budgets: Readonly<Record<string, number>>; graphs: Readonly<Record<string, string>>;
};

export function readDemoSettings(env: NodeJS.ProcessEnv, config: BffConfig): DemoSettings {
  const fail = (name: string): never => { throw new Error(`invalid_configuration:${name}`); };
  const text = (name: string) => env[name]?.trim() || fail(name);
  const integer = (name: string) => { const value = Number(text(name)); return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fail(name); };
  const object = (name: string): Record<string, unknown> => {
    try { const value: unknown = JSON.parse(text(name)); if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value)); }
    catch { /* Report only the setting name. */ }
    return fail(name);
  };
  text("BFF_ALLOWED_ORIGINS");
  if (!config.allowedOrigins.length || config.allowedOrigins.some(origin => {
    try { const url = new URL(origin); return origin.includes("*") || url.origin !== origin || !["https:", "http:"].includes(url.protocol); }
    catch { return true; }
  })) fail("BFF_ALLOWED_ORIGINS");
  if (!Object.hasOwn(env, "BFF_TRUSTED_PROXIES")) fail("BFF_TRUSTED_PROXIES");
  parseTrustedProxies(env.BFF_TRUSTED_PROXIES);
  const redisUri = text("USAGE_LEDGER_REDIS_URI");
  try { if (!["redis:", "rediss:"].includes(new URL(redisUri).protocol)) fail("USAGE_LEDGER_REDIS_URI"); }
  catch { fail("USAGE_LEDGER_REDIS_URI"); }
  const timeZone = text("USAGE_LEDGER_TIME_ZONE");
  try { ledgerDate(Date.now(), timeZone); } catch { fail("USAGE_LEDGER_TIME_ZONE"); }
  const currency = text("DEMO_BUDGET_CURRENCY");
  if (!/^[A-Z]{3}$/u.test(currency)) fail("DEMO_BUDGET_CURRENCY");
  const sessionSecret = text("DEMO_SESSION_SECRET");
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) fail("DEMO_SESSION_SECRET");
  const leaseTtlMs = integer("DEMO_LEASE_TTL_MS");
  const upstreamTimeoutMs = integer("BFF_UPSTREAM_TIMEOUT_MS");
  if (leaseTtlMs - upstreamTimeoutMs < 30_000 || leaseTtlMs - upstreamTimeoutMs > 120_000) fail("DEMO_LEASE_TTL_MS");
  const budgets = object("DEMO_BUDGETS_JSON");
  if (["site", ...DEMO_SCOPES].some(scope => !Number.isSafeInteger(budgets[scope]) || Number(budgets[scope]) <= 0)
      || Object.keys(budgets).some(scope => !["site", ...DEMO_SCOPES].some(known => known === scope))
      || DEMO_SCOPES.reduce((sum, scope) => sum + Number(budgets[scope]), 0) > Number(budgets.site)) fail("DEMO_BUDGETS_JSON");
  const graphs = object("DEMO_GRAPH_BUDGETS_JSON");
  if (!Object.keys(graphs).length || Object.entries(graphs).some(([graph, scope]) =>
    !Object.values(DEMO_GRAPHS).some(value => value === graph) || !DEMO_SCOPES.some(value => value === scope && value !== "reserve"))) fail("DEMO_GRAPH_BUDGETS_JSON");
  for (const key of ["BFF_RATE_LIMIT_USER_MAX_REQUESTS", "BFF_RATE_LIMIT_USER_WINDOW_MS", "BFF_RATE_LIMIT_IP_MAX_REQUESTS", "BFF_RATE_LIMIT_IP_WINDOW_MS"]) integer(key);
  return {
    redisUri, timeZone, currency, keyPrefix: text("USAGE_LEDGER_KEY_PREFIX"), sessionSecret, leaseTtlMs,
    sessionLifetimeMs: integer("DEMO_SESSION_LIFETIME_MS"), timeoutMs: integer("DEMO_BUDGET_TIMEOUT_MS"),
    concurrency: integer("DEMO_CONCURRENCY_LIMIT"), dailyIpRuns: integer("DEMO_RESEARCH_IP_DAILY_RUNS"),
    budgets: Object.fromEntries(Object.entries(budgets).map(([key, value]) => [key, Number(value)])),
    graphs: Object.fromEntries(Object.entries(graphs).map(([key, value]) => [key, String(value)])),
  };
}
