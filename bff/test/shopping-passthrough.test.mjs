import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { createServer } from "../dist/server.js";

// X43 T9: proves the existing LangGraph proxy carries shopping_assistant
// traffic without BFF changes. Whether the backend accepts a resume run for
// the original approval (runId binding, S9) is out of scope here.

const threadId = "5f0c2a5e-3d0b-4c39-9f53-6bb3c7f1a222";
const originalRunId = "1f0b8e9a-6c1d-4f7e-9a2b-3c4d5e6f7a81";
const requestId = "0b6f3a52-8f0e-4c2a-9d71-5e2f4b8c1a33";
const idempotencyKey = "7c1e9d24-3b5a-4f86-a0c7-2d9e8f1b6a44";

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

function config(upstreamUrl, overrides = {}) {
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
    ...overrides,
  };
}

/** `respond(request, response)` answers each upstream request after its body is read. */
async function withServers(respond, run, configOverrides) {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const recorded = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        response,
      };
      upstreamRequests.push(recorded);
      respond(recorded, response);
    });
  });
  const upstreamUrl = await start(upstream);
  const bff = createServer(config(upstreamUrl, configOverrides));
  const bffUrl = await start(bff);
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await run({ bffUrl, upstreamRequests, logs });
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    await close(bff);
    await close(upstream);
  }
}

function respondJson(_request, response) {
  response.setHeader("content-type", "application/json");
  response.end('{"ok":true}');
}

function post(bffUrl, path, body, headers = {}) {
  return fetch(`${bffUrl}/api/langgraph${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "trusted-key",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Mirrors frontend `withInteractionRequestMetadata` plus the headers its fetch adds. */
function interactionRequest(body, { inputKind, generation = 2 } = {}) {
  const activeRunHint = { runId: originalRunId, generation };
  return {
    body: {
      ...body,
      config: {
        configurable: {
          clientInteractionMetadata: {
            requestId,
            idempotencyKey,
            activeRunHint,
            ...(inputKind ? { inputKind } : {}),
          },
        },
      },
      stream_mode: ["values", "updates", "messages-tuple", "custom"],
      on_disconnect: "cancel",
    },
    headers: {
      "x-request-id": requestId,
      "x-idempotency-key": idempotencyKey,
      "x-active-run-id": activeRunHint.runId,
      "x-active-run-generation": String(activeRunHint.generation),
    },
  };
}

function cardEmitEnvelope(sequence, cardType, data) {
  return {
    schemaVersion: "1.0.0",
    eventId: `${originalRunId}:card:${sequence}`,
    sequence,
    type: "card.emit",
    emittedAt: "2026-10-25T00:00:00.000Z",
    context: { threadId, runId: originalRunId, taskId: originalRunId },
    payload: { cardType, data },
  };
}

test("streams shopping_assistant runs with card.emit runtime events byte for byte", async () => {
  const productCard = cardEmitEnvelope(1, "product_result", {
    schemaVersion: "product_result@1",
    citationId: "c1",
    sourceId: "product-001",
    sourceVersion: "kb-v1",
    title: "保溫杯",
    snippet: "容量 500ml",
  });
  const statusCard = cardEmitEnvelope(2, "order_operation_status", {
    schemaVersion: "order_operation_status@1",
    operationRef: { toolCallId: "call-1" },
    kind: "refund",
    orderRef: "ORD-1001",
    state: "awaiting_approval",
    stateVersion: 1,
  });
  const events = [
    `event: metadata\ndata: ${JSON.stringify({ run_id: originalRunId, attempt: 1 })}\n\n`,
    `event: updates\ndata: ${JSON.stringify({ product_present: { runtimeEvents: [productCard] } })}\n\n`,
    `event: updates\ndata: ${JSON.stringify({ order_request: { runtimeEvents: [statusCard] } })}\n\n`,
    "event: end\ndata: null\n\n",
  ];
  const upstreamBytes = Buffer.from(events.join(""), "utf8");
  // Split mid-event and inside a multi-byte character to prove the proxy does not reframe.
  const titleOffset = upstreamBytes.indexOf(Buffer.from("保溫杯", "utf8"));
  const cuts = [17, titleOffset + 1, upstreamBytes.length - 5];

  await withServers(
    async (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-location": `/threads/${threadId}/runs/${originalRunId}`,
      });
      let offset = 0;
      for (const cut of [...cuts, upstreamBytes.length]) {
        response.write(upstreamBytes.subarray(offset, cut));
        offset = cut;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      response.end();
    },
    async ({ bffUrl, upstreamRequests }) => {
      const response = await post(bffUrl, `/threads/${threadId}/runs/stream`, {
        assistant_id: "shopping_assistant",
        input: { kind: "prompt", messages: [{ type: "human", content: "幫我找保溫杯" }] },
        stream_mode: ["values", "updates", "messages-tuple", "custom"],
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(
        response.headers.get("content-location"),
        `/threads/${threadId}/runs/${originalRunId}`,
      );
      const received = Buffer.from(await response.arrayBuffer());
      assert.ok(received.equals(upstreamBytes), "stream bytes changed in transit");

      const updates = received
        .toString("utf8")
        .split("\n\n")
        .filter((frame) => frame.startsWith("event: updates\n"))
        .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));
      assert.deepEqual(updates[0].product_present.runtimeEvents, [productCard]);
      assert.deepEqual(updates[1].order_request.runtimeEvents, [statusCard]);

      assert.equal(upstreamRequests.length, 1);
      assert.equal(upstreamRequests[0].url, `/threads/${threadId}/runs/stream`);
      assert.equal(JSON.parse(upstreamRequests[0].body).assistant_id, "shopping_assistant");
    },
  );
});

test("forwards a tool approval resume with its active-run hint to the original thread", async () => {
  await withServers(respondJson, async ({ bffUrl, upstreamRequests }) => {
    const resume = interactionRequest({
      assistant_id: "shopping_assistant",
      command: {
        resume: {
          type: "tool_authorization_confirmation",
          approvalId: "approval-1",
          decisionId: "decision-1",
          decision: "approve",
        },
      },
    });
    const response = await post(
      bffUrl,
      `/threads/${threadId}/runs/stream`,
      resume.body,
      resume.headers,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), requestId);

    assert.equal(upstreamRequests.length, 1);
    const [forwarded] = upstreamRequests;
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.url, `/threads/${threadId}/runs/stream`);
    assert.deepEqual(JSON.parse(forwarded.body), resume.body);
    assert.equal(forwarded.headers["x-active-run-id"], originalRunId);
    assert.equal(forwarded.headers["x-active-run-generation"], "2");
    assert.equal(forwarded.headers["x-request-id"], requestId);
    // The client key is re-derived per tenant and principal before it reaches the runtime.
    assert.match(forwarded.headers["x-idempotency-key"], /^[a-f0-9]{64}$/);
    assert.notEqual(forwarded.headers["x-idempotency-key"], idempotencyKey);
    assert.equal(forwarded.headers["x-bff-principal-id"], "trusted-principal");
    assert.equal(forwarded.headers["x-bff-tenant-id"], "trusted-tenant");
  });
});

test("rejects a malformed active-run hint before it reaches the runtime", async () => {
  await withServers(respondJson, async ({ bffUrl, upstreamRequests }) => {
    const resume = interactionRequest({
      assistant_id: "shopping_assistant",
      command: { resume: { type: "tool_authorization_confirmation", decision: "approve" } },
    });
    const cases = [
      [{ "x-active-run-generation": undefined }, "incomplete_active_run_hint"],
      [{ "x-active-run-generation": "0" }, "invalid_active_run_hint"],
    ];
    for (const [override, errorCode] of cases) {
      const headers = { ...resume.headers, ...override };
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) delete headers[name];
      }
      const response = await post(bffUrl, `/threads/${threadId}/runs/stream`, resume.body, headers);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, errorCode);
    }
    assert.equal(upstreamRequests.length, 0);
  });
});

test("strips client-injected identity headers from shopping_assistant runs", async () => {
  await withServers(respondJson, async ({ bffUrl, upstreamRequests }) => {
    const forged = {
      "x-user-id": "forged-user",
      "x-tenant-id": "forged-tenant",
      "x-bff-user-id": "forged-user",
      "x-bff-principal-id": "synthetic-shopper-a",
      "x-bff-principal-type": "user",
      "x-bff-principal-kind": "authenticated",
      "x-bff-tenant-id": "synthetic-tenant",
      "x-bff-account-id": "forged-account",
      "x-bff-session-id": "forged-session",
      "x-bff-device-id": "forged-device",
      "x-bff-roles": "admin",
      "x-bff-scopes": "orders:refund",
      "x-bff-scope-id": "forged-scope",
      "x-bff-scope-type": "tenant",
      "x-bff-auth-source": "forged",
      "x-bff-authenticated-at": "2000-01-01T00:00:00.000Z",
      "x-bff-idempotency-ttl-ms": "1",
    };
    const response = await post(
      bffUrl,
      `/threads/${threadId}/runs/stream`,
      {
        assistant_id: "shopping_assistant",
        input: { kind: "prompt", messages: [{ type: "human", content: "退款 ORD-1001" }] },
      },
      forged,
    );
    assert.equal(response.status, 200);

    const [forwarded] = upstreamRequests;
    const headers = forwarded.headers;
    assert.equal(headers["x-user-id"], undefined);
    assert.equal(headers["x-tenant-id"], undefined);
    assert.equal(headers["x-bff-principal-id"], "trusted-principal");
    assert.equal(headers["x-bff-user-id"], "trusted-principal");
    assert.equal(headers["x-bff-principal-type"], "service");
    assert.equal(headers["x-bff-tenant-id"], "trusted-tenant");
    assert.equal(headers["x-bff-roles"], "operator");
    assert.equal(headers["x-bff-scopes"], "runs:write");
    assert.notEqual(headers["x-bff-principal-kind"], forged["x-bff-principal-kind"]);
    assert.notEqual(headers["x-bff-scope-id"], forged["x-bff-scope-id"]);
    assert.notEqual(headers["x-bff-auth-source"], forged["x-bff-auth-source"]);
    assert.notEqual(headers["x-bff-authenticated-at"], forged["x-bff-authenticated-at"]);
    // The API-key principal has no account, session or device; forged values must not survive.
    assert.equal(headers["x-bff-account-id"], undefined);
    assert.equal(headers["x-bff-session-id"], undefined);
    assert.equal(headers["x-bff-device-id"], undefined);
    // No idempotency key was sent, so the trusted TTL header must not be forwarded either.
    assert.equal(headers["x-bff-idempotency-ttl-ms"], undefined);
    const serialized = JSON.stringify(headers);
    for (const value of ["forged", "synthetic-shopper-a", "synthetic-tenant", "admin", "orders:refund"]) {
      assert.ok(!serialized.includes(value), `forged identity value leaked: ${value}`);
    }
  });
});

test("aborts the upstream run when the browser disconnects, then forwards the cancel input", async () => {
  let upstreamStreamClosed;
  const streamClosed = new Promise((resolve) => {
    upstreamStreamClosed = resolve;
  });

  await withServers(
    (request, response) => {
      if (request.url === `/threads/${threadId}/runs/stream` && JSON.parse(request.body).input?.kind === "prompt") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`event: metadata\ndata: ${JSON.stringify({ run_id: originalRunId, attempt: 1 })}\n\n`);
        // Keep the stream open: only the disconnect can end it before the timeout.
        response.on("close", () => upstreamStreamClosed({ ended: response.writableEnded }));
        return;
      }
      respondJson(request, response);
    },
    async ({ bffUrl, upstreamRequests, logs }) => {
      const browser = new AbortController();
      const stream = await fetch(`${bffUrl}/api/langgraph/threads/${threadId}/runs/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "trusted-key" },
        body: JSON.stringify({
          assistant_id: "shopping_assistant",
          input: { kind: "prompt", messages: [{ type: "human", content: "退款 ORD-1001" }] },
          on_disconnect: "cancel",
        }),
        signal: browser.signal,
      });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString("utf8"), /event: metadata/);

      const startedAt = Date.now();
      browser.abort();
      const closed = await Promise.race([
        streamClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream stream was not aborted")), 3_000),
        ),
      ]);
      assert.equal(closed.ended, false, "upstream must be cut, not completed");
      assert.ok(Date.now() - startedAt < 3_000);
      const upstreamErrors = logs
        .filter((line) => line.includes("bff_upstream_error"))
        .map((line) => JSON.parse(line));
      for (const entry of upstreamErrors) {
        assert.equal(entry.clientDisconnected, true);
      }

      // Frontend handleCancel: thread.stop() above, then a cancel input on the same thread.
      const cancel = interactionRequest(
        { assistant_id: "shopping_assistant", input: { kind: "cancel", targetRunId: originalRunId } },
        { inputKind: "cancel" },
      );
      const cancelResponse = await post(
        bffUrl,
        `/threads/${threadId}/runs/stream`,
        cancel.body,
        cancel.headers,
      );
      assert.equal(cancelResponse.status, 200);

      const runCancel = await fetch(
        `${bffUrl}/api/langgraph/threads/${threadId}/runs/${originalRunId}/cancel?wait=0&action=interrupt`,
        { method: "POST", headers: { "x-api-key": "trusted-key" } },
      );
      assert.equal(runCancel.status, 200);

      assert.equal(upstreamRequests.length, 3);
      const [, forwardedCancel, forwardedRunCancel] = upstreamRequests;
      assert.equal(forwardedCancel.url, `/threads/${threadId}/runs/stream`);
      assert.deepEqual(JSON.parse(forwardedCancel.body), cancel.body);
      assert.equal(forwardedCancel.headers["x-active-run-id"], originalRunId);
      assert.equal(forwardedCancel.headers["x-active-run-generation"], "2");
      assert.equal(forwardedRunCancel.method, "POST");
      assert.equal(
        forwardedRunCancel.url,
        `/threads/${threadId}/runs/${originalRunId}/cancel?wait=0&action=interrupt`,
      );
    },
    { upstreamTimeoutMs: 10_000 },
  );
});
