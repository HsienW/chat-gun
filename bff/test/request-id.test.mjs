import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
));

async function start(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    apiKeyPrincipals: new Map([["trusted-key", {
      principalId: "trusted-principal",
      principalType: "service",
      tenantId: "trusted-tenant",
      roles: ["operator"],
      scopes: ["runs:read"],
    }]]),
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

async function rawRequest(url, headerPairs) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: headerPairs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("validates request IDs and overwrites untrusted identity before proxying", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push(request.headers);
    response.end("ok");
  });
  const upstreamUrl = await start(upstream);
  const bff = createServer(config(upstreamUrl));
  const bffUrl = await start(bff);
  try {
    const valid = await fetch(`${bffUrl}/api/langgraph/runs`, {
      headers: {
        "x-api-key": "trusted-key",
        "x-request-id": fixture.validContext.requestId,
        "x-user-id": "forged-user",
        "x-tenant-id": "forged-tenant",
        "x-bff-principal-id": "forged-principal",
      },
    });
    assert.equal(valid.status, 200);
    assert.equal(upstreamRequests[0]["x-request-id"], fixture.validContext.requestId);
    assert.equal(upstreamRequests[0]["x-bff-principal-id"], "trusted-principal");
    assert.equal(upstreamRequests[0]["x-bff-tenant-id"], "trusted-tenant");
    assert.equal(upstreamRequests[0]["x-user-id"], undefined);

    const generated = await fetch(`${bffUrl}/api/langgraph/runs`, {
      headers: { "x-api-key": "trusted-key" },
    });
    assert.equal(generated.status, 200);
    assert.match(generated.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);

    const duplicate = await rawRequest(`${bffUrl}/api/langgraph/runs`, [
      "host", new URL(bffUrl).host,
      "x-api-key", "trusted-key",
      "x-request-id", "request-1",
      "x-request-id", "request-2",
    ]);
    assert.equal(duplicate.status, 400);
    assert.equal(JSON.parse(duplicate.body).error.code, "duplicate_request_id_header");

    for (const requestId of [fixture.malformedRequestId, "x".repeat(fixture.oversizedIdLength)]) {
      const invalid = await fetch(`${bffUrl}/api/langgraph/runs`, {
        headers: { "x-api-key": "trusted-key", "x-request-id": requestId },
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "invalid_request_id");
    }
    assert.equal(upstreamRequests.length, 2);
  } finally {
    await close(bff);
    await close(upstream);
  }
});
