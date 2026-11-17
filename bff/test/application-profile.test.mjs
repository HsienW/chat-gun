import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

// stream-chat-answer-text Task 6.5 (design D12 disconnect recovery): the BFF reports the
// deployment profile so the frontend can choose its recovery mode without guessing.

function config() {
  return {
    port: 0,
    langGraphApiUrl: new URL("http://127.0.0.1:9"),
    metricsBackendUrl: new URL("http://127.0.0.1:9"),
    frontendDist: ".",
    allowedOrigins: [],
    requireAuth: true,
    apiKeys: new Set(["trusted-key"]),
    apiKeyPrincipals: new Map(),
    legacyHeaderMode: true,
    maxBodyBytes: 1024 * 1024,
    upstreamTimeoutMs: 1_000,
    idempotencyTtlMs: 300_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1_000,
    redisRateLimitUri: undefined,
    rateLimitUserMaxRequests: 1_000,
    rateLimitUserWindowMs: 60_000,
    rateLimitIpMaxRequests: 1_000,
    rateLimitIpWindowMs: 60_000,
    imageUploadMaxFiles: 6,
    imageUploadMaxBytes: 5 * 1024 * 1024,
    imageUploadMaxPixels: 24_000_000,
    imageUploadAllowedExtensions: new Set([".png"]),
    imageUploadAllowedMimeTypes: new Set(["image/png"]),
    imageUploadS3BucketUrl: "",
  };
}

async function withServer(dependencies, run) {
  const server = createServer(config(), dependencies);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("reports the full profile when no application profile is composed, without auth and uncached", async () => {
  await withServer({}, async (url) => {
    const response = await fetch(`${url}/api/application-profile`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { schemaVersion: "1", profile: "full" });
  });
});

test("reports the demo profile from the composed dependencies", async () => {
  await withServer({ applicationProfile: "demo" }, async (url) => {
    const response = await fetch(`${url}/api/application-profile`);
    assert.deepEqual(await response.json(), { schemaVersion: "1", profile: "demo" });
  });
});

test("answers HEAD without a body and rejects other methods", async () => {
  await withServer({}, async (url) => {
    const head = await fetch(`${url}/api/application-profile`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const post = await fetch(`${url}/api/application-profile`, { method: "POST" });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
  });
});
