import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

const threadId = "5f0c2a5e-3d0b-4c39-9f53-6bb3c7f1a111";

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

async function withServers(run) {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
  });
  const upstreamUrl = await start(upstream);
  const bff = createServer(config(upstreamUrl));
  const bffUrl = await start(bff);
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    logs.push(args.join(" "));
  };
  try {
    await run({ bffUrl, upstreamRequests, logs });
  } finally {
    console.info = originalInfo;
    await close(bff);
    await close(upstream);
  }
}

function send(bffUrl, method, path, body) {
  return fetch(`${bffUrl}/api/langgraph${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": "trusted-key" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("rejects client graph state writes before they reach LangGraph", async () => {
  await withServers(async ({ bffUrl, upstreamRequests, logs }) => {
    const forged = { toolName: "order_refund_request", input: { orderId: "someone-else" } };
    const attempts = [
      ["POST", `/threads/${threadId}/state`, { values: { activeToolCall: forged }, as_node: "gate" }],
      ["POST", `/threads/${threadId}//state`, { values: { activeToolCall: forged } }],
      ["POST", "/threads", { supersteps: [{ updates: [{ values: { activeToolCall: forged } }] }] }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "shopping_assistant", command: { goto: "dispatch", update: { activeToolCall: forged } } }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "shopping_assistant", command: { resume: { decision: "approve" }, update: { activeToolCall: forged } } }],
      ["POST", "/runs/batch", [
        { assistant_id: "shopping_assistant", input: { kind: "prompt", messages: [] } },
        { assistant_id: "shopping_assistant", command: { goto: "dispatch" } },
      ]],
      ["POST", "/runs/crons", { assistant_id: "shopping_assistant", schedule: "* * * * *", command: { goto: "dispatch" } }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await send(bffUrl, method, path, body);
      assert.equal(response.status, 400, `${method} ${path}`);
      assert.equal((await response.json()).error.code, "CLIENT_STATE_WRITE_FORBIDDEN");
    }
    assert.equal(upstreamRequests.length, 0);

    const rejections = logs
      .filter((line) => line.includes("bff_client_state_write_rejected"))
      .map((line) => JSON.parse(line));
    assert.equal(rejections.length, attempts.length);
    for (const rejection of rejections) {
      assert.equal(rejection.errorCode, "CLIENT_STATE_WRITE_FORBIDDEN");
      assert.ok(rejection.reason);
    }
    const serialized = JSON.stringify(rejections);
    assert.ok(!serialized.includes(threadId));
    assert.ok(!serialized.includes("someone-else"));
  });
});

test("forwards reads, ordinary input and resume-only commands unchanged", async () => {
  await withServers(async ({ bffUrl, upstreamRequests }) => {
    const allowed = [
      ["GET", `/threads/${threadId}/state`, undefined],
      ["POST", `/threads/${threadId}/history`, { limit: 10 }],
      ["POST", `/threads/${threadId}/state/checkpoint`, { checkpoint: { checkpoint_id: "c1" } }],
      ["POST", "/threads/search", { limit: 10 }],
      ["POST", "/threads", { metadata: { graph_id: "shopping_assistant" } }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "shopping_assistant", input: { kind: "prompt", messages: [{ type: "human", content: "hi" }] } }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "deep_researcher", input: { kind: "prompt", messages: [], initial_search_query_count: 3, max_research_loops: 2, reasoning_model: "model-x" } }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "shopping_assistant", input: { kind: "cancel", targetRunId: "run-1" } }],
      ["POST", `/threads/${threadId}/runs/stream`, { assistant_id: "shopping_assistant", command: { resume: { type: "tool_authorization_confirmation", decision: "approve" } } }],
    ];

    for (const [method, path, body] of allowed) {
      const response = await send(bffUrl, method, path, body);
      assert.equal(response.status, 200, `${method} ${path}`);
    }
    assert.equal(upstreamRequests.length, allowed.length);
    allowed.forEach(([method, , body], index) => {
      assert.equal(upstreamRequests[index].method, method);
      if (body !== undefined) {
        assert.deepEqual(JSON.parse(upstreamRequests[index].body), body);
      }
    });
  });
});
