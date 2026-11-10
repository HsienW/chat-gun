import { Redis } from "ioredis";
import type { BffConfig } from "./config.js";
import type { ServerDependencies } from "./server.js";
import { SharedUsageLedgerReader } from "./usage-ledger-reader.js";
import { readDemoSettings } from "./demo/config.js";
import { DemoAdmissionPolicy, RedisDemoAdmissionStore } from "./demo/admission-policy.js";
import { VisitorSessionResolver } from "./demo/visitor-session.js";

/** The sole BFF deployment switch; generic modules receive interfaces only. */
export function composeApplicationProfile(config: BffConfig, env: NodeJS.ProcessEnv = process.env): ServerDependencies {
  const flag = env.DEMO_ENABLED;
  if (flag !== undefined && !["true", "false"].includes(flag)) throw new Error("invalid_configuration:DEMO_ENABLED");
  if (flag !== "true") return {};
  const settings = readDemoSettings(env, config);
  const redis = new Redis(settings.redisUri, { lazyConnect: false, connectTimeout: settings.timeoutMs,
    commandTimeout: settings.timeoutMs, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
  redis.on("error", () => { /* Reader/policy fail closed without logging connection credentials. */ });
  config.redisRateLimitUri = settings.redisUri;
  const observe = (event: string) => console.warn(JSON.stringify({ event }));
  const metadataUrl = new URL("internal/usage-ledger/metadata", config.langGraphApiUrl.toString().replace(/\/?$/u, "/"));
  const reader = new SharedUsageLedgerReader({ redis, timeoutMs: settings.timeoutMs,
    expected: { version: "usage-ledger@1", currency: settings.currency, keyPrefix: settings.keyPrefix, timeZone: settings.timeZone }, observe,
    backendMetadata: async signal => {
      const response = await fetch(metadataUrl, { signal, redirect: "error" });
      if (!response.ok) throw new Error("usage_budget_unavailable");
      return response.json();
    },
  });
  return { admissionPolicy: new DemoAdmissionPolicy(settings, reader, new RedisDemoAdmissionStore(redis, `${settings.keyPrefix}:admission`)),
    subjectResolver: new VisitorSessionResolver(settings.sessionSecret, settings.sessionLifetimeMs),
    redisClient: redis, closeRedis: async () => { redis.disconnect(); }, onClose: () => redis.disconnect(),
    readinessCheck: async () => { await reader.read(); return true; },
  };
}
