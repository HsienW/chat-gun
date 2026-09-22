import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";

const RATE_LIMIT_ENV_NAMES = [
  "BFF_RATE_LIMIT_REDIS_URI",
  "BFF_RATE_LIMIT_USER_MAX_REQUESTS",
  "BFF_RATE_LIMIT_USER_WINDOW_MS",
  "BFF_RATE_LIMIT_IP_MAX_REQUESTS",
  "BFF_RATE_LIMIT_IP_WINDOW_MS",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Redis rate limit configuration", () => {
  it("loads the Redis URI and independent user/IP limits", () => {
    vi.stubEnv("BFF_RATE_LIMIT_REDIS_URI", "redis://localhost:6379");
    vi.stubEnv("BFF_RATE_LIMIT_USER_MAX_REQUESTS", "30");
    vi.stubEnv("BFF_RATE_LIMIT_USER_WINDOW_MS", "60000");
    vi.stubEnv("BFF_RATE_LIMIT_IP_MAX_REQUESTS", "20");
    vi.stubEnv("BFF_RATE_LIMIT_IP_WINDOW_MS", "45000");

    expect(loadConfig()).toMatchObject({
      redisRateLimitUri: "redis://localhost:6379",
      rateLimitUserMaxRequests: 30,
      rateLimitUserWindowMs: 60_000,
      rateLimitIpMaxRequests: 20,
      rateLimitIpWindowMs: 45_000,
    });
  });

  it("uses safe defaults when optional values are absent or invalid", () => {
    for (const name of RATE_LIMIT_ENV_NAMES) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("BFF_RATE_LIMIT_USER_MAX_REQUESTS", "invalid");
    vi.stubEnv("BFF_RATE_LIMIT_IP_WINDOW_MS", "-1");

    expect(loadConfig()).toMatchObject({
      redisRateLimitUri: undefined,
      rateLimitUserMaxRequests: 30,
      rateLimitUserWindowMs: 60_000,
      rateLimitIpMaxRequests: 20,
      rateLimitIpWindowMs: 60_000,
    });
  });
});

describe("metrics backend configuration", () => {
  it("defaults to the configured LangGraph API URL", () => {
    vi.stubEnv("BFF_LANGGRAPH_API_URL", "http://langgraph.internal:2024");
    vi.stubEnv("AGENT_METRICS_BACKEND_URL", "");

    expect(loadConfig().metricsBackendUrl.toString()).toBe(
      "http://langgraph.internal:2024/"
    );
  });

  it("uses the dedicated metrics backend URL when configured", () => {
    vi.stubEnv("BFF_LANGGRAPH_API_URL", "http://langgraph.internal:2024");
    vi.stubEnv("AGENT_METRICS_BACKEND_URL", "http://metrics.internal:9090");

    expect(loadConfig().metricsBackendUrl.toString()).toBe(
      "http://metrics.internal:9090/"
    );
  });
});

describe("idempotency TTL configuration", () => {
  it("covers the upstream timeout and applies configured bounds", () => {
    vi.stubEnv("BFF_UPSTREAM_TIMEOUT_MS", "120000");
    vi.stubEnv("BFF_IDEMPOTENCY_TTL_MS", "1000");
    expect(loadConfig().idempotencyTtlMs).toBe(120_000);

    vi.stubEnv("BFF_IDEMPOTENCY_TTL_MS", String(90 * 24 * 60 * 60 * 1_000));
    expect(loadConfig().idempotencyTtlMs).toBe(30 * 24 * 60 * 60 * 1_000);
  });

  it("uses a safe default longer than the default upstream timeout", () => {
    vi.stubEnv("BFF_UPSTREAM_TIMEOUT_MS", "");
    vi.stubEnv("BFF_IDEMPOTENCY_TTL_MS", "");

    const config = loadConfig();
    expect(config.idempotencyTtlMs).toBeGreaterThanOrEqual(
      config.upstreamTimeoutMs
    );
  });
});

describe("identity compatibility configuration", () => {
  it("keeps legacy trusted headers enabled by default", () => {
    vi.stubEnv("BFF_LEGACY_HEADER_MODE", "");

    expect(loadConfig().legacyHeaderMode).toBe(true);
  });

  it("requires one valid active scope in every API-key principal profile", () => {
    vi.stubEnv(
      "BFF_API_KEY_PRINCIPALS_JSON",
      JSON.stringify({
        key: {
          principalId: "service-1",
          principalType: "service",
          tenantId: "tenant-1",
          roles: [],
          scopes: ["runs:read"],
        },
      })
    );

    expect(() => loadConfig()).toThrow(
      "BFF_API_KEY_PRINCIPALS_JSON contains an invalid profile"
    );
  });

  it("normalizes permission scopes and rejects comma-containing tokens", () => {
    vi.stubEnv(
      "BFF_API_KEY_PRINCIPALS_JSON",
      JSON.stringify({
        key: {
          principalId: "service-1",
          principalType: "service",
          tenantId: "tenant-1",
          roles: [],
          scopes: [" runs:read ", "runs:read", "runs:write"],
          activeScope: { scopeId: "tenant-1", scopeType: "tenant" },
        },
      })
    );
    expect(loadConfig().apiKeyPrincipals.get("key")?.scopes).toEqual([
      "runs:read",
      "runs:write",
    ]);

    vi.stubEnv(
      "BFF_API_KEY_PRINCIPALS_JSON",
      JSON.stringify({
        key: {
          principalId: "service-1",
          principalType: "service",
          tenantId: "tenant-1",
          roles: [],
          scopes: ["runs:read,runs:write"],
          activeScope: { scopeId: "tenant-1", scopeType: "tenant" },
        },
      })
    );
    expect(() => loadConfig()).toThrow(
      "BFF_API_KEY_PRINCIPALS_JSON contains an invalid profile"
    );
  });
});
