import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

// stream-chat-answer-text Task 5 (bff-stream-proxy delta spec, design D10): SSE passthrough
// declares no intermediary buffering, forwards the first frame while upstream pauses, and leaves
// non-SSE responses, cancellation, error and interruption behavior unchanged.

const threadId = "5f0c2a5e-3d0b-4c39-9f53-6bb3c7f1a333";

async function start(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
      ["trusted-key", { principalId: "trusted-principal", principalType: "service", tenantId: "trusted-tenant", roles: ["operator"], scopes: ["runs:write"] }],
    ]),
    legacyHeaderMode: true,
    maxBodyBytes: 1024 * 1024,
    upstreamTimeoutMs: 5_000,
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
    imageUploadAllowedExtensions: new Set([".png", ".jpg", ".jpeg", ".webp"]),
    imageUploadAllowedMimeTypes: new Set(["image/png", "image/jpeg", "image/webp"]),
    imageUploadS3BucketUrl: "",
  };
}

async function withServers(respond, run) {
  const upstreamClosed = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => respond(request, response));
    response.on("close", () => upstreamClosed.push(response.writableFinished));
  });
  const upstreamUrl = await start(upstream);
  const bff = createServer(config(upstreamUrl));
  const bffUrl = await start(bff);
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = () => undefined;
  console.error = () => undefined;
  try {
    await run({ bffUrl, upstreamClosed });
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    await close(bff);
    await close(upstream);
  }
}

function postRun(bffUrl, signal) {
  return fetch(`${bffUrl}/api/langgraph/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "trusted-key" },
    body: JSON.stringify({
      assistant_id: "chatbot",
      input: { kind: "prompt", messages: [{ type: "human", content: "hi" }] },
      stream_mode: ["values", "custom"],
    }),
    signal,
  });
}

const firstFrame = 'event: custom\ndata: {"type":"model.stream","payload":{"delta":"你好","textOffset":0}}\n\n';
const secondFrame = 'event: custom\ndata: {"type":"model.stream","payload":{"delta":"世界","textOffset":2}}\n\n';

test("declares no intermediary buffering for SSE and forwards the first frame while upstream pauses", async () => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await withServers(
    async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      response.write(firstFrame);
      await released;
      response.end(secondFrame);
    },
    async ({ bffUrl }) => {
      const response = await postRun(bffUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(response.headers.get("content-encoding"), null);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("\n\n")) {
        const { value, done } = await reader.read();
        assert.equal(done, false, "stream ended before the first frame");
        received += decoder.decode(value, { stream: true });
      }
      // Upstream is still paused: only the first frame may have arrived.
      assert.equal(received, firstFrame);

      release();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      assert.equal(received, firstFrame + secondFrame);
    },
  );
});

test("leaves non-SSE response headers unchanged", async () => {
  await withServers(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60" });
      response.end('{"ok":true}');
    },
    async ({ bffUrl }) => {
      const response = await postRun(bffUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-accel-buffering"), null);
      assert.equal(response.headers.get("cache-control"), "max-age=60");
      assert.deepEqual(await response.json(), { ok: true });
    },
  );
});

test("keeps upstream error status and body for an error before headers, without SSE headers", async () => {
  await withServers(
    (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"unavailable"}');
    },
    async ({ bffUrl }) => {
      const response = await postRun(bffUrl);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-accel-buffering"), null);
      await response.arrayBuffer();
    },
  );
});

test("propagates client cancellation to the upstream SSE request", async () => {
  await withServers(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(firstFrame);
      // Never ends on its own; only a propagated cancel closes it.
    },
    async ({ bffUrl, upstreamClosed }) => {
      const controller = new AbortController();
      const response = await postRun(bffUrl, controller.signal);
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      await reader.read().catch(() => undefined);

      const deadline = Date.now() + 2_000;
      while (upstreamClosed.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(upstreamClosed, [false], "upstream response was not closed by the cancel");
    },
  );
});

test("keeps the existing SSE error frame when upstream breaks mid-stream, after forwarding what arrived", async () => {
  await withServers(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(firstFrame, () => setTimeout(() => response.destroy(), 20));
    },
    async ({ bffUrl }) => {
      const response = await postRun(bffUrl);
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
      } catch {
        // A destroyed downstream is also an acceptable terminal signal.
      }
      assert.ok(received.startsWith(firstFrame), "first frame was not forwarded before the break");
      // Anything after the forwarded frame is the BFF's existing SSE error frame, never more answer text.
      const tail = received.slice(firstFrame.length);
      assert.ok(tail === "" || /^event: error\n/.test(tail), `unexpected tail after break: ${JSON.stringify(tail.slice(0, 120))}`);
      assert.ok(!tail.includes("model.stream"));
    },
  );
});
