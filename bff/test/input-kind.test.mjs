import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

const inputFixture = JSON.parse(
  readFileSync(
    new URL("../../contracts/input-normalization.fixture.json", import.meta.url),
    "utf8",
  ),
);

async function start(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function config(upstreamUrl) {
  return {
    port: 0,
    langGraphApiUrl: new URL(upstreamUrl),
    metricsBackendUrl: new URL(upstreamUrl),
    frontendDist: ".",
    allowedOrigins: [],
    requireAuth: true,
    apiKeys: new Set(["trusted-key"]),
    apiKeyPrincipals: new Map([
      [
        "trusted-key",
        {
          principalId: "trusted-principal",
          principalType: "service",
          tenantId: "trusted-tenant",
          roles: ["operator"],
          scopes: ["runs:write"],
        },
      ],
    ]),
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
  };
}

async function withServers(run) {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
  });
  const upstreamUrl = await start(upstream);
  const bff = createServer(config(upstreamUrl));
  const bffUrl = await start(bff);
  try {
    await run({ bffUrl, upstreamRequests });
  } finally {
    await close(bff);
    await close(upstream);
  }
}

async function post(bffUrl, body, headers = {}) {
  return fetch(`${bffUrl}/api/langgraph/runs/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "trusted-key",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("allows every known input kind and legacy bodies", async () => {
  await withServers(async ({ bffUrl, upstreamRequests }) => {
    const bodies = [
      { input: inputFixture.prompt.normalized },
      { input: inputFixture.cancel.withTarget },
      { input: { kind: "command", commandId: "refresh" } },
      {
        input: null,
        config: {
          configurable: {
            clientInteractionMetadata: {
              inputKind:
                inputFixture.clarification.resumeTransport.config.configurable
                  .clientInteractionMetadata.inputKind,
              interruptId: inputFixture.clarification.interruptId,
            },
          },
        },
      },
      { input: { messages: ["legacy"] } },
    ];

    for (const body of bodies) {
      const response = await post(bffUrl, body);
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      upstreamRequests.map((request) => JSON.parse(request.body)),
      bodies,
    );
  });
});

test("rejects unknown, non-string, and conflicting kinds with a stable code", async () => {
  await withServers(async ({ bffUrl, upstreamRequests }) => {
    const bodies = [
      { input: inputFixture.unknown },
      { input: { kind: 42 } },
      {
        input: { kind: "prompt", text: "hello" },
        config: {
          configurable: {
            clientInteractionMetadata: { inputKind: "cancel" },
          },
        },
      },
    ];

    for (const body of bodies) {
      const response = await post(bffUrl, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "unsupported_input_kind");
    }
    assert.equal(upstreamRequests.length, 0);
  });
});

test("preserves idempotency and active-run header behavior", async () => {
  await withServers(async ({ bffUrl, upstreamRequests }) => {
    const response = await post(
      bffUrl,
      { input: { kind: "prompt", text: "hello" } },
      {
        "x-idempotency-key": "logical-submit-1",
        "x-active-run-id": "run-1",
        "x-active-run-generation": "3",
      },
    );

    assert.equal(response.status, 200);
    assert.match(upstreamRequests[0].headers["x-idempotency-key"], /^[a-f0-9]{64}$/);
    assert.equal(upstreamRequests[0].headers["x-bff-idempotency-ttl-ms"], "300000");
    assert.equal(upstreamRequests[0].headers["x-active-run-id"], "run-1");
    assert.equal(upstreamRequests[0].headers["x-active-run-generation"], "3");
  });
});
