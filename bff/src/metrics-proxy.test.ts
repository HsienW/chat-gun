import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { BffConfig } from "./config.js";
import type { OperationsMetricsAuthorizer } from "./metrics-proxy.js";
import { createServer } from "./server.js";

interface StartedServer {
  url: string;
  close(): Promise<void>;
}

function createConfig(upstreamUrl: string): BffConfig {
  return {
    port: 0,
    langGraphApiUrl: new URL(upstreamUrl),
    metricsBackendUrl: new URL(upstreamUrl),
    operationsRuntimeDeploymentId: "runtime-1",
    operationsTenantId: "tenant-1",
    operationsScopeId: "scope-1",
    frontendDist: ".",
    allowedOrigins: [],
    requireAuth: true,
    apiKeys: new Set(["reader-key"]),
    apiKeyPrincipals: new Map([
      [
        "reader-key",
        {
          principalId: "service-1",
          principalType: "service",
          tenantId: "tenant-1",
          roles: ["operations-reader"],
          scopes: ["operations:metrics:read"],
        },
      ],
    ]),
    legacyHeaderMode: true,
    maxBodyBytes: 1024,
    upstreamTimeoutMs: 1_000,
    idempotencyTtlMs: 300_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1_000,
    redisRateLimitUri: undefined,
    rateLimitUserMaxRequests: 1_000,
    rateLimitUserWindowMs: 60_000,
    rateLimitIpMaxRequests: 1_000,
    rateLimitIpWindowMs: 60_000,
    imageUploadMaxFiles: 1,
    imageUploadMaxBytes: 1_024,
    imageUploadMaxPixels: 1_024,
    imageUploadAllowedExtensions: new Set([".png"]),
    imageUploadAllowedMimeTypes: new Set(["image/png"]),
    imageUploadS3BucketUrl: "",
  };
}

async function startServer(server: Server): Promise<StartedServer> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("operations metrics proxy", () => {
  it("denies unauthenticated and unauthorized requests without calling upstream", async () => {
    let upstreamCalls = 0;
    const upstream = await startServer(
      http.createServer((_req, res) => {
        upstreamCalls += 1;
        res.end("unexpected");
      })
    );
    const authorizer: OperationsMetricsAuthorizer = {
      authorize: vi.fn(async () => ({
        effect: "deny" as const,
        reasonCode: "ACTION_NOT_ALLOWED",
      })),
    };
    const bff = await startServer(
      createServer(createConfig(upstream.url), { operationsMetricsAuthorizer: authorizer })
    );

    try {
      expect((await fetch(`${bff.url}/api/operations/metrics`)).status).toBe(401);
      expect(
        (
          await fetch(`${bff.url}/api/operations/metrics`, {
            headers: { "x-api-key": "reader-key" },
          })
        ).status
      ).toBe(403);
      expect(upstreamCalls).toBe(0);
    } finally {
      await bff.close();
      await upstream.close();
    }
  });

  it("authorizes a trusted principal and streams only the allowlisted request headers", async () => {
    let observedPath: string | undefined;
    let observedApiKey: string | undefined;
    let observedRequestId: string | undefined;
    const upstream = await startServer(
      http.createServer((req, res) => {
        observedPath = req.url;
        observedApiKey = req.headers["x-api-key"] as string | undefined;
        observedRequestId = req.headers["x-request-id"] as string | undefined;
        res.writeHead(200, {
          "content-type": "application/openmetrics-text; version=1.0.0; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": "must-not-forward=true",
        });
        res.end("chat_gun_task_total 1\n# EOF\n");
      })
    );
    const authorize = vi.fn(async () => ({ effect: "allow" as const, reasonCode: "POLICY_ALLOWED" }));
    const bff = await startServer(
      createServer(createConfig(upstream.url), {
        operationsMetricsAuthorizer: { authorize },
      })
    );

    try {
      const response = await fetch(`${bff.url}/api/operations/metrics`, {
        headers: { "x-api-key": "reader-key", accept: "application/openmetrics-text" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/openmetrics-text");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("chat_gun_task_total 1");
      expect(observedPath).toBe("/operations/metrics");
      expect(observedApiKey).toBeUndefined();
      expect(observedRequestId).toEqual(expect.any(String));
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "operations.metrics.read",
          resource: expect.objectContaining({
            resourceType: "runtime_metrics",
            resourceId: "runtime-1",
            tenantId: "tenant-1",
          }),
          scope: expect.objectContaining({ scopeId: "scope-1", tenantId: "tenant-1" }),
        })
      );
    } finally {
      await bff.close();
      await upstream.close();
    }
  });

  it("uses trusted principal grants when production startup has no custom authorizer", async () => {
    const upstream = await startServer(
      http.createServer((_req, res) => {
        res.writeHead(200, {
          "content-type":
            "application/openmetrics-text; version=1.0.0; charset=utf-8",
        });
        res.end("chat_gun_task_total 1\n# EOF\n");
      })
    );
    const bff = await startServer(createServer(createConfig(upstream.url)));

    try {
      const response = await fetch(`${bff.url}/api/operations/metrics`, {
        headers: { "x-api-key": "reader-key" },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("chat_gun_task_total 1");
    } finally {
      await bff.close();
      await upstream.close();
    }
  });

  it("rejects unsupported methods and all query parameters", async () => {
    const upstream = await startServer(http.createServer((_req, res) => res.end("unexpected")));
    const authorizer: OperationsMetricsAuthorizer = {
      authorize: async () => ({ effect: "allow", reasonCode: "POLICY_ALLOWED" }),
    };
    const bff = await startServer(
      createServer(createConfig(upstream.url), { operationsMetricsAuthorizer: authorizer })
    );

    try {
      const headers = { "x-api-key": "reader-key" };
      expect((await fetch(`${bff.url}/api/operations/metrics?tenant=other`, { headers })).status).toBe(400);
      expect((await fetch(`${bff.url}/api/operations/metrics`, { method: "POST", headers })).status).toBe(405);
    } finally {
      await bff.close();
      await upstream.close();
    }
  });
});
