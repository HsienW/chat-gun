import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import { createServer } from "./server.js";
import type { ServerDependencies } from "./server.js";
import type { BffConfig } from "./config.js";
import type { RedisEvalClient } from "./redis-rate-limit.js";

const sharedAuthorizationFixture = JSON.parse(
  readFileSync(
    new URL("../../contracts/execution-context.fixture.json", import.meta.url),
    "utf8"
  )
) as {
  trustedAuthorization: {
    confirmation: {
      interrupt: Record<string, unknown>;
      resumeApprove: Record<string, unknown>;
    };
  };
};

type StartedServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

function createTestConfig(langGraphApiUrl: string, overrides: Partial<BffConfig> = {}): BffConfig {
  return {
    port: 0,
    langGraphApiUrl: new URL(langGraphApiUrl),
    metricsBackendUrl: new URL(langGraphApiUrl),
    frontendDist: ".",
    allowedOrigins: [],
    requireAuth: false,
    apiKeys: new Set(),
    apiKeyPrincipals: new Map(),
    legacyHeaderMode: true,
    maxBodyBytes: 1024 * 1024,
    upstreamTimeoutMs: 1_000,
    idempotencyTtlMs: 300_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1_000,
    redisRateLimitUri: undefined,
    rateLimitUserMaxRequests: 30,
    rateLimitUserWindowMs: 60_000,
    rateLimitIpMaxRequests: 20,
    rateLimitIpWindowMs: 60_000,
    imageUploadMaxFiles: 6,
    imageUploadMaxBytes: 5 * 1024 * 1024,
    imageUploadMaxPixels: 24_000_000,
    imageUploadAllowedExtensions: new Set([".png", ".jpg", ".jpeg", ".webp"]),
    imageUploadAllowedMimeTypes: new Set(["image/png", "image/jpeg", "image/webp"]),
    imageUploadS3BucketUrl: "",
    ...overrides,
  };
}

async function startServer(server: Server): Promise<StartedServer> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function withServer<T>(
  handler: http.RequestListener,
  run: (started: StartedServer) => Promise<T>
): Promise<T> {
  const started = await startServer(http.createServer(handler));
  try {
    return await run(started);
  } finally {
    await started.close();
  }
}

async function withBff<T>(
  config: BffConfig,
  run: (started: StartedServer) => Promise<T>,
  dependencies?: ServerDependencies
): Promise<T> {
  const started = await startServer(createServer(config, dependencies));
  try {
    return await run(started);
  } finally {
    await started.close();
  }
}

async function rawRequest(
  url: string,
  headers: http.OutgoingHttpHeaders | string[]
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

describe("BFF metrics proxy", () => {
  it("requires BFF authentication and does not forward the client credential", async () => {
    let upstreamCalls = 0;
    let upstreamApiKey: string | undefined;

    await withServer(
      (req, res) => {
        upstreamCalls += 1;
        upstreamApiKey = req.headers["x-api-key"] as string | undefined;
        assert.equal(req.url, "/metrics");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tasks: { total: 1 } }));
      },
      async (upstream) => {
        const config = createTestConfig(upstream.url, {
          metricsBackendUrl: new URL(upstream.url),
          requireAuth: true,
          apiKeys: new Set(["bff-secret"]),
          apiKeyPrincipals: new Map([
            [
              "bff-secret",
              {
                principalId: "metrics-service",
                principalType: "service",
                tenantId: "tenant-metrics",
                roles: ["metrics-reader"],
                scopes: ["metrics:read"],
                activeScope: { scopeId: "tenant-metrics", scopeType: "tenant" },
              },
            ],
          ]),
        });

        await withBff(config, async (bff) => {
          const unauthorized = await fetch(`${bff.url}/api/metrics`);
          assert.equal(unauthorized.status, 401);
          assert.equal(upstreamCalls, 0);

          const authorized = await fetch(`${bff.url}/api/metrics`, {
            headers: { "x-api-key": "bff-secret" },
          });
          assert.equal(authorized.status, 200);
          assert.deepEqual(await authorized.json(), { tasks: { total: 1 } });
          assert.equal(upstreamCalls, 1);
          assert.equal(upstreamApiKey, undefined);
        });
      }
    );
  });

  it("preserves the metrics backend failure status and response body", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "metrics unavailable" }));
      },
      async (upstream) => {
        await withBff(
          createTestConfig(upstream.url, {
            metricsBackendUrl: new URL(upstream.url),
          }),
          async (bff) => {
            const response = await fetch(`${bff.url}/api/metrics`);
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), {
              error: "metrics unavailable",
            });
          }
        );
      }
    );
  });

  it("returns bff_timeout when the metrics backend exceeds the timeout", async () => {
    await withServer(
      (_req, _res) => {
        // Keep the request open until the BFF aborts it.
      },
      async (upstream) => {
        await withBff(
          createTestConfig(upstream.url, {
            metricsBackendUrl: new URL(upstream.url),
            upstreamTimeoutMs: 25,
          }),
          async (bff) => {
            const response = await fetch(`${bff.url}/api/metrics`);
            const body = await response.json();

            assert.equal(response.status, 504);
            assert.equal(body.error.code, "bff_timeout");
            assert.equal(body.error.stage, "metrics_upstream_proxy");
          }
        );
      }
    );
  });
});

describe("BFF LangGraph stream proxy", () => {
  it("forwards W3C trace context headers unchanged", async () => {
    let traceparent: string | undefined;
    let tracestate: string | undefined;

    await withServer(
      (req, res) => {
        traceparent = req.headers.traceparent as string | undefined;
        tracestate = req.headers.tracestate as string | undefined;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              traceparent:
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              tracestate: "vendor=value",
            },
          });

          assert.equal(response.status, 200);
          assert.equal(
            traceparent,
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
          );
          assert.equal(tracestate, "vendor=value");
        });
      }
    );
  });

  it("does not generate trace context when the incoming request has none", async () => {
    let traceparent: string | undefined;

    await withServer(
      (req, res) => {
        traceparent = req.headers.traceparent as string | undefined;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`);
          assert.equal(response.status, 200);
          assert.equal(traceparent, undefined);
        });
      }
    );
  });


  it("forwards a trusted namespaced idempotency key when present", async () => {
    let forwardedIdempotencyKey: string | undefined;
    let forwardedPrincipal: string | undefined;
    let forwardedTenant: string | undefined;
    let forwardedTtl: string | undefined;

    await withServer(
      (req, res) => {
        const header = req.headers["x-idempotency-key"];
        forwardedIdempotencyKey = Array.isArray(header) ? header[0] : header;
        forwardedPrincipal = req.headers["x-bff-user-id"] as string | undefined;
        forwardedTenant = req.headers["x-bff-tenant-id"] as string | undefined;
        forwardedTtl = req.headers["x-bff-idempotency-ttl-ms"] as
          | string
          | undefined;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url, {
          requireAuth: true,
          apiKeys: new Set(["bff-key"]),
          apiKeyPrincipals: new Map([
            [
              "bff-key",
              {
                principalId: "principal-1",
                principalType: "service",
                tenantId: "tenant-1",
                roles: ["runner"],
                scopes: ["runs:write"],
                activeScope: { scopeId: "tenant-1", scopeType: "tenant" },
              },
            ],
          ]),
        }), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              "x-api-key": "bff-key",
              "x-user-id": "principal-1",
              "x-tenant-id": "tenant-1",
              "x-idempotency-key": "client-key-1",
            },
          });

          assert.equal(response.status, 200);
          assert.match(forwardedIdempotencyKey ?? "", /^[a-f0-9]{64}$/);
          assert.notEqual(forwardedIdempotencyKey, "client-key-1");
          assert.equal(forwardedPrincipal, "principal-1");
          assert.equal(forwardedTenant, "tenant-1");
          assert.equal(forwardedTtl, "300000");
        });
      }
    );
  });

  it("forwards the client active-run hint without making an ownership decision", async () => {
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    await withServer(
      (req, res) => {
        upstreamHeaders = req.headers;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              "x-active-run-id": "run-current-1",
              "x-active-run-generation": "42",
            },
          });

          assert.equal(response.status, 200);
          assert.equal(upstreamHeaders["x-active-run-id"], "run-current-1");
          assert.equal(upstreamHeaders["x-active-run-generation"], "42");
        });
      }
    );
  });

  it("rejects incomplete or malformed active-run hints before proxying", async () => {
    let upstreamCalls = 0;
    await withServer(
      (_req, res) => {
        upstreamCalls += 1;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const incomplete = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: { "x-active-run-id": "run-current-1" },
          });
          const malformed = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              "x-active-run-id": "run-current-1",
              "x-active-run-generation": "0",
            },
          });

          assert.equal(incomplete.status, 400);
          assert.equal(malformed.status, 400);
          assert.equal(upstreamCalls, 0);
        });
      }
    );
  });

  it("emits canonical trusted headers from the resolver and ignores raw identity", async () => {
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    await withServer(
      (req, res) => {
        upstreamHeaders = req.headers;
        res.end("ok");
      },
      async (upstream) => {
        const config = createTestConfig(upstream.url, {
          requireAuth: true,
          apiKeys: new Set(["bff-key"]),
          apiKeyPrincipals: new Map([
            [
              "bff-key",
              {
                principalId: "trusted-principal",
                principalType: "service",
                tenantId: "trusted-tenant",
                roles: ["operator", "auditor"],
                scopes: ["runs:read", "runs:write"],
                activeScope: { scopeId: "team-7", scopeType: "team" },
              },
            ],
          ]),
          legacyHeaderMode: true,
        });

        await withBff(config, async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              "x-api-key": "bff-key",
              "x-user-id": "attacker",
              "x-tenant-id": "attacker-tenant",
            },
          });
          assert.equal(response.status, 200);
        });
      }
    );

    assert.equal(upstreamHeaders["x-user-id"], undefined);
    assert.equal(upstreamHeaders["x-tenant-id"], undefined);
    assert.equal(upstreamHeaders["x-bff-principal-id"], "trusted-principal");
    assert.equal(upstreamHeaders["x-bff-principal-type"], "service");
    assert.equal(upstreamHeaders["x-bff-tenant-id"], "trusted-tenant");
    assert.equal(upstreamHeaders["x-bff-roles"], "operator,auditor");
    assert.equal(upstreamHeaders["x-bff-scopes"], "runs:read,runs:write");
    assert.equal(upstreamHeaders["x-bff-scope-id"], "team-7");
    assert.equal(upstreamHeaders["x-bff-scope-type"], "team");
    assert.equal(upstreamHeaders["x-bff-auth-source"], "service_token");
    assert.match(
      String(upstreamHeaders["x-bff-authenticated-at"]),
      /^\d{4}-\d{2}-\d{2}T/
    );
    assert.equal(upstreamHeaders["x-bff-user-id"], "trusted-principal");
  });

  it("disables only the legacy user header when legacyHeaderMode is false", async () => {
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    await withServer(
      (req, res) => {
        upstreamHeaders = req.headers;
        res.end("ok");
      },
      async (upstream) => {
        const config = createTestConfig(upstream.url, {
          requireAuth: true,
          apiKeys: new Set(["bff-key"]),
          apiKeyPrincipals: new Map([
            [
              "bff-key",
              {
                principalId: "trusted-principal",
                principalType: "service",
                tenantId: "trusted-tenant",
                roles: [],
                scopes: [],
                activeScope: { scopeId: "trusted-tenant", scopeType: "tenant" },
              },
            ],
          ]),
          legacyHeaderMode: false,
        });

        await withBff(config, async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: { "x-api-key": "bff-key" },
          });
          assert.equal(response.status, 200);
        });
      }
    );

    assert.equal(upstreamHeaders["x-bff-user-id"], undefined);
    assert.equal(upstreamHeaders["x-bff-principal-id"], "trusted-principal");
    assert.equal(upstreamHeaders["x-bff-tenant-id"], "trusted-tenant");
  });

  it("includes canonical and alias idempotency headers in CORS preflight", async () => {
    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        allowedOrigins: ["https://app.example.test"],
      }),
      async (bff) => {
        const response = await fetch(`${bff.url}/api/langgraph/runs`, {
          method: "OPTIONS",
          headers: { origin: "https://app.example.test" },
        });
        const allowedHeaders = response.headers.get(
          "access-control-allow-headers"
        );
        assert.equal(response.status, 204);
        assert.match(allowedHeaders ?? "", /x-idempotency-key/i);
        assert.match(allowedHeaders ?? "", /idempotency-key/i);
        assert.match(allowedHeaders ?? "", /x-active-run-id/i);
        assert.match(allowedHeaders ?? "", /x-active-run-generation/i);
      }
    );
  });

  it("rejects duplicate canonical headers and alias conflicts", async () => {
    let upstreamCalls = 0;
    await withServer(
      (_req, res) => {
        upstreamCalls += 1;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const duplicate = await rawRequest(`${bff.url}/api/langgraph/runs`, {
            "x-idempotency-key": ["key-1", "key-2"],
          });
          assert.equal(duplicate.statusCode, 400);

          const conflict = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: {
              "x-idempotency-key": "key-1",
              "idempotency-key": "key-2",
            },
          });
          assert.equal(conflict.status, 400);
          assert.equal(upstreamCalls, 0);
        });
      }
    );
  });

  it("validates request ID and rejects duplicate or malformed correlation before proxying", async () => {
    let forwardedRequestId: string | undefined;
    let upstreamCalls = 0;
    await withServer(
      (req, res) => {
        upstreamCalls += 1;
        forwardedRequestId = req.headers["x-request-id"] as string | undefined;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const legal = await fetch(`${bff.url}/api/langgraph/runs`, {
            headers: { "x-request-id": "request-1:attempt.2" },
          });
          assert.equal(legal.status, 200);
          assert.equal(forwardedRequestId, "request-1:attempt.2");

          const duplicate = await rawRequest(`${bff.url}/api/langgraph/runs`, [
            "host", new URL(bff.url).host,
            "x-request-id", "request-1", "x-request-id", "request-2",
          ]);
          assert.equal(duplicate.statusCode, 400);
          assert.equal(JSON.parse(duplicate.body).error.code, "duplicate_request_id_header");

          for (const requestId of ["invalid id", "x".repeat(257)]) {
            const invalid = await fetch(`${bff.url}/api/langgraph/runs`, {
              headers: { "x-request-id": requestId },
            });
            assert.equal(invalid.status, 400);
            assert.equal((await invalid.json()).error.code, "invalid_request_id");
          }
          assert.equal(upstreamCalls, 1);
        });
      }
    );
  });

  it("rejects invalid idempotency key format and length", async () => {
    await withBff(createTestConfig("http://127.0.0.1:1"), async (bff) => {
      const invalidFormat = await fetch(`${bff.url}/api/langgraph/runs`, {
        headers: { "x-idempotency-key": "invalid key" },
      });
      assert.equal(invalidFormat.status, 400);

      const tooLong = await fetch(`${bff.url}/api/langgraph/runs`, {
        headers: { "x-idempotency-key": "x".repeat(257) },
      });
      assert.equal(tooLong.status, 400);
    });
  });

  it("keeps requestDedupKey absent when no idempotency header is present", async () => {
    let forwardedIdempotencyKey: string | undefined;
    let forwardedTtl: string | undefined;
    await withServer(
      (req, res) => {
        forwardedIdempotencyKey = req.headers["x-idempotency-key"] as
          | string
          | undefined;
        forwardedTtl = req.headers["x-bff-idempotency-ttl-ms"] as
          | string
          | undefined;
        res.end("ok");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs`);
          assert.equal(response.status, 200);
          assert.equal(forwardedIdempotencyKey, undefined);
          assert.equal(forwardedTtl, undefined);
        });
      }
    );
  });

  it("proxies upstream stream chunks in order", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        res.end("data: two\n\n");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
          const text = await response.text();

          assert.equal(response.status, 200);
          assert.equal(text, "data: one\n\ndata: two\n\n");
        });
      }
    );
  });

  it("passes task event generation through without modification", async () => {
    const frame = [
      "event: task_event",
      'data: {"eventType":"superseded","payload":{"generation":42}}',
      "",
      "",
    ].join("\n");

    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frame);
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
          assert.equal(await response.text(), frame);
        });
      }
    );
  });

  it("passes LangGraph interrupt and unknown SSE events through unchanged", async () => {
    const interruptFrame = [
      "event: interrupt",
      'data: {"__interrupt__":[{"value":{"type":"weather_clarification"}}]}',
      "",
      "",
    ].join("\n");
    const unknownFrame = [
      "event: langgraph_future_event",
      'data: {"payload":{"status":"waiting"}}',
      "",
      "",
    ].join("\n");

    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(interruptFrame);
        res.end(unknownFrame);
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
          const text = await response.text();

          assert.equal(response.status, 200);
          assert.equal(text, `${interruptFrame}${unknownFrame}`);
        });
      }
    );
  });

  it("passes authorization interrupt/resume unchanged while overwriting canonical identity", async () => {
    const resumeBody = {
      command: {
        resume: sharedAuthorizationFixture.trustedAuthorization.confirmation.resumeApprove,
      },
    };
    const interruptFrame = [
      "event: interrupt",
      `data: ${JSON.stringify({
        __interrupt__: [{
          value: sharedAuthorizationFixture.trustedAuthorization.confirmation.interrupt,
        }],
      })}`,
      "",
      "",
    ].join("\n");
    let upstreamBody = "";
    let upstreamHeaders: http.IncomingHttpHeaders = {};

    await withServer(
      (req, res) => {
        upstreamHeaders = req.headers;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          upstreamBody += chunk;
        });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(interruptFrame);
        });
      },
      async (upstream) => {
        const config = createTestConfig(upstream.url, {
          requireAuth: true,
          apiKeys: new Set(["bff-key"]),
          apiKeyPrincipals: new Map([
            [
              "bff-key",
              {
                principalId: "trusted-principal",
                principalType: "user",
                tenantId: "trusted-tenant",
                roles: ["operator"],
                scopes: ["tool:approve"],
                activeScope: { scopeId: "trusted-tenant", scopeType: "tenant" },
              },
            ],
          ]),
        });
        await withBff(config, async (bff) => {
          const response = await fetch(
            `${bff.url}/api/langgraph/threads/thread-1/runs/stream`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": "bff-key",
                "x-bff-principal-id": "forged",
                "x-bff-scope-id": "forged-scope",
              },
              body: JSON.stringify(resumeBody),
            }
          );

          assert.equal(response.status, 200);
          assert.equal(await response.text(), interruptFrame);
        });
      }
    );

    assert.equal(upstreamBody, JSON.stringify(resumeBody));
    assert.equal(upstreamHeaders["x-bff-principal-id"], "trusted-principal");
    assert.equal(upstreamHeaders["x-bff-tenant-id"], "trusted-tenant");
    assert.equal(upstreamHeaders["x-bff-scope-id"], "trusted-tenant");
    assert.equal(upstreamHeaders["x-bff-scope-type"], "tenant");
  });

  it("returns bff_timeout when upstream exceeds BFF_UPSTREAM_TIMEOUT_MS", async () => {
    await withServer(
      (_req, _res) => {
        // Keep the upstream request open until the BFF timeout aborts it.
      },
      async (upstream) => {
        await withBff(
          createTestConfig(upstream.url, { upstreamTimeoutMs: 25 }),
          async (bff) => {
            const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
            const body = await response.json();

            assert.equal(response.status, 504);
            assert.equal(body.error.code, "bff_timeout");
            assert.equal(body.error.details.requestId, response.headers.get("x-request-id"));
          }
        );
      }
    );
  });

  it("maps request body close before complete to client_disconnected", async () => {
    let upstreamCalled = false;
    let resolveLog: (value: Record<string, unknown>) => void;
    const logged = new Promise<Record<string, unknown>>((resolve) => {
      resolveLog = resolve;
    });
    const originalError = console.error;

    console.error = (message?: unknown, ...args: unknown[]) => {
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as Record<string, unknown>;
          if (
            parsed.event === "bff_upstream_error" &&
            parsed.errorCode === "client_disconnected"
          ) {
            resolveLog(parsed);
          }
        } catch {
          // Keep non-JSON console.error behavior unchanged below.
        }
      }
      originalError(message, ...args);
    };

    try {
      await withServer(
        (_req, res) => {
          upstreamCalled = true;
          res.end("unexpected");
        },
        async (upstream) => {
          await withBff(createTestConfig(upstream.url), async (bff) => {
            const port = new URL(bff.url).port;
            const socket = net.createConnection(Number(port), "127.0.0.1");
            await once(socket, "connect");
            socket.write(
              [
                "POST /api/langgraph/runs/stream HTTP/1.1",
                "Host: 127.0.0.1",
                "Content-Length: 100",
                "Content-Type: application/json",
                "",
                "{\"partial\":",
              ].join("\r\n")
            );
            socket.destroy();

            const log = await Promise.race([
              logged,
              new Promise<never>((_resolve, reject) =>
                setTimeout(
                  () => reject(new Error("Timed out waiting for disconnect log")),
                  1_000
                )
              ),
            ]);

            assert.equal(log.errorCode, "client_disconnected");
            assert.equal(upstreamCalled, false);
          });
        }
      );
    } finally {
      console.error = originalError;
    }
  });

  it("writes a trailing SSE error frame when upstream stream fails after headers", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("data: before\n\n");
        setImmediate(() => res.destroy(new Error("upstream stream failed")));
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
          const text = await response.text();

          assert.equal(response.status, 200);
          assert.match(text, /data: before/);
          assert.match(text, /event: error/);
          assert.match(text, /"code":"upstream_stream_error"/);
          assert.doesNotMatch(text, /"rawMessage"/);
        });
      }
    );
  });

  it("writes bff_timeout when an SSE stream exceeds the upstream timeout after headers", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("data: before\n\n");
      },
      async (upstream) => {
        await withBff(
          createTestConfig(upstream.url, { upstreamTimeoutMs: 25 }),
          async (bff) => {
            const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
            const text = await response.text();

            assert.equal(response.status, 200);
            assert.match(text, /data: before/);
            assert.match(text, /event: error/);
            assert.match(text, /"code":"bff_timeout"/);
          }
        );
      }
    );
  });

  it("does not inject JSON when a non-SSE stream fails after headers", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.flushHeaders();
        res.write("partial");
        setImmediate(() => res.destroy(new Error("upstream stream failed")));
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`);
          assert.equal(response.status, 200);

          try {
            const text = await response.text();
            assert.equal(text.includes('"error"'), false);
          } catch (error) {
            assert(error instanceof Error);
          }
        });
      }
    );
  });

  it("aborts upstream when the client disconnects before response headers", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    let markUpstreamClosed: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve;
    });

    await withServer(
      (req, _res) => {
        markUpstreamStarted?.();
        req.on("close", () => markUpstreamClosed?.());
      },
      async (upstream) => {
        await withBff(
          createTestConfig(upstream.url, { upstreamTimeoutMs: 500 }),
          async (bff) => {
            const controller = new AbortController();
            const clientRequest = fetch(`${bff.url}/api/langgraph/runs/stream`, {
              signal: controller.signal,
            }).catch((error: unknown) => error);
            await upstreamStarted;

            controller.abort();
            const closedPromptly = await Promise.race([
              upstreamClosed.then(() => true),
              new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), 100)
              ),
            ]);
            await clientRequest;

            assert.equal(closedPromptly, true);
          }
        );
      }
    );
  });

  it("aborts upstream when the downstream stream closes", async () => {
    let upstreamClosed = false;

    await withServer(
      (req, res) => {
        req.on("close", () => {
          upstreamClosed = true;
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      },
      async (upstream) => {
        await withBff(createTestConfig(upstream.url), async (bff) => {
          const controller = new AbortController();
          const response = await fetch(`${bff.url}/api/langgraph/runs/stream`, {
            signal: controller.signal,
          });
          const reader = response.body?.getReader();
          assert(reader);
          await reader.read();
          controller.abort();

          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(upstreamClosed, true);
        });
      }
    );
  });
});

describe("BFF Redis rate limiting", () => {
  it("reports the limiting dimension headers on an allowed request", async () => {
    const redisClient: RedisEvalClient = {
      eval: async (_script, _numberOfKeys, key) =>
        String(key).includes("rate_limit:user:anonymous")
          ? [1, 2, 0]
          : [1, 12, 0],
    };

    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        redisRateLimitUri: "redis://localhost:6379",
        rateLimitUserMaxRequests: 3,
      }),
      async (bff) => {
        const response = await fetch(`${bff.url}/not-found`, {
          headers: { "x-user-id": "alice" },
        });

        assert.equal(response.status, 404);
        assert.equal(response.headers.get("x-ratelimit-limit"), "3");
        assert.equal(response.headers.get("x-ratelimit-remaining"), "2");
        assert(
          Number(response.headers.get("x-ratelimit-reset")) >
            Math.floor(Date.now() / 1_000)
        );
      },
      { redisClient }
    );
  });

  it("returns the standard 429 contract when the user dimension is denied", async () => {
    const redisClient: RedisEvalClient = {
      eval: async (_script, _numberOfKeys, key, _maxRequests, _windowMs, now) => {
        return String(key).includes("rate_limit:user:anonymous")
          ? [0, 0, Number(now) + 45_000]
          : [1, 19, 0];
      },
    };

    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        redisRateLimitUri: "redis://localhost:6379",
      }),
      async (bff) => {
        const response = await fetch(`${bff.url}/not-found`, {
          headers: { "x-user-id": "alice" },
        });
        const body = await response.json();

        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), "45");
        assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
        assert(Number(response.headers.get("x-ratelimit-reset")) > 0);
        assert.deepEqual(body, { error: "Rate limit exceeded", retryAfter: 45 });
      },
      { redisClient }
    );
  });

  it("uses the socket peer for the IP dimension instead of spoofed forwarding headers", async () => {
    const checkedKeys: string[] = [];
    const redisClient: RedisEvalClient = {
      eval: async (_script, _numberOfKeys, key, _maxRequests, _windowMs, now) => {
        checkedKeys.push(String(key));
        return String(key).includes("rate_limit:ip:127.0.0.1")
          ? [0, 0, Number(now) + 300]
          : [1, 29, 0];
      },
    };

    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        redisRateLimitUri: "redis://localhost:6379",
      }),
      async (bff) => {
        const response = await fetch(`${bff.url}/not-found`, {
          headers: {
            "x-user-id": "bob",
            "x-forwarded-for": "203.0.113.99",
          },
        });
        const body = await response.json();

        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), "1");
        assert.deepEqual(body, { error: "Rate limit exceeded", retryAfter: 1 });
        assert(checkedKeys.includes("rate_limit:user:anonymous"));
        assert(checkedKeys.includes("rate_limit:ip:127.0.0.1"));
        assert.equal(checkedKeys.some((key) => key.includes("203.0.113.99")), false);
        assert.equal(checkedKeys.some((key) => key.includes("bob")), false);
      },
      { redisClient }
    );
  });

  it("keeps the legacy composite-key limiter when Redis is not configured", async () => {
    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        rateLimitMaxRequests: 1,
      }),
      async (bff) => {
        const headers = {
          "x-user-id": "alice",
          "x-tenant-id": "tenant-a",
        };
        const firstResponse = await fetch(`${bff.url}/not-found`, { headers });
        const secondResponse = await fetch(`${bff.url}/not-found`, { headers });
        const body = await secondResponse.json();

        assert.equal(firstResponse.status, 404);
        assert.equal(secondResponse.status, 429);
        assert(Number(secondResponse.headers.get("retry-after")) >= 1);
        assert.equal(typeof body.retryAfter, "number");
      }
    );
  });

  it("closes the Redis client when the server closes", async () => {
    let closeCalls = 0;
    const redisClient: RedisEvalClient = {
      eval: async () => [1, 29, 0],
    };

    await withBff(
      createTestConfig("http://127.0.0.1:1", {
        redisRateLimitUri: "redis://localhost:6379",
      }),
      async () => undefined,
      {
        redisClient,
        closeRedis: async () => {
          closeCalls += 1;
        },
      }
    );

    assert.equal(closeCalls, 1);
  });
});
