import { describe, expect, it, vi } from "vitest";

import { EgressPolicyError } from "../runtime/tool-dispatch/egress-policy.js";
import { HttpKnowledgeModelGateway, type KnowledgeHttp, type KnowledgeUsageEvent } from "./model-gateway.js";
import { testKnowledgeConfig } from "./testing-fakes.js";

const CREDENTIAL = "sk-test-credential-value-123456";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function embeddingResponse(count: number, dimensions = 64): Response {
  return jsonResponse({
    data: Array.from({ length: count }, (_, index) => ({ index, embedding: new Array(dimensions).fill(index + 1) })),
    usage: { total_tokens: count * 3 },
  });
}

function createGateway(http: KnowledgeHttp, overrides: Record<string, string> = {}) {
  const usage: KnowledgeUsageEvent[] = [];
  const gateway = new HttpKnowledgeModelGateway(testKnowledgeConfig(overrides), http, (event) => usage.push(event));
  return { gateway, usage };
}

describe("knowledge model gateway", () => {
  it("batches embeddings within the provider limit and reports usage without the credential", async () => {
    const http = vi.fn<KnowledgeHttp>(async (_url, init) => {
      const body = JSON.parse(init.body) as { input: string[]; model: string; dimensions: number };
      expect(body.model).toBe("text-embedding-v4");
      expect(body.dimensions).toBe(64);
      return embeddingResponse(body.input.length);
    });
    const { gateway, usage } = createGateway(http);
    const vectors = await gateway.embed(Array.from({ length: 23 }, (_, index) => `text ${index}`), { credential: CREDENTIAL });

    expect(vectors).toHaveLength(23);
    expect(http.mock.calls.map(([, init]) => (JSON.parse(init.body) as { input: string[] }).input.length)).toEqual([10, 10, 3]);
    expect(http.mock.calls[0][0]).toBe("https://embedding.example.test/compatible-mode/v1/embeddings");
    expect(http.mock.calls[0][1].headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(usage).toHaveLength(3);
    expect(usage.every((event) => event.purpose === "embedding" && event.outcome === "succeeded")).toBe(true);
    expect(JSON.stringify(usage)).not.toContain(CREDENTIAL);
  });

  it("fails with a typed dimension mismatch when the provider returns another dimension", async () => {
    const { gateway } = createGateway(async () => embeddingResponse(1, 32));
    await expect(gateway.embed(["text"], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_EMBEDDING_DIMENSION_MISMATCH" });
  });

  it("rejects empty or oversized input before any request", async () => {
    const http = vi.fn<KnowledgeHttp>();
    const { gateway } = createGateway(http);
    await expect(gateway.embed([""], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_EMBEDDING_INPUT_TOO_LARGE" });
    await expect(gateway.embed(["x".repeat(24_001)], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_EMBEDDING_INPUT_TOO_LARGE" });
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    [429, "KB_PROVIDER_RATE_LIMITED", true],
    [504, "KB_PROVIDER_TIMEOUT", true],
    [500, "KB_PROVIDER_ERROR", false],
  ])("classifies HTTP %s as %s", async (status, code, retryable) => {
    const { gateway, usage } = createGateway(async () => jsonResponse({ code: "x" }, status));
    await expect(gateway.embed(["text"], { credential: CREDENTIAL })).rejects.toMatchObject({ code, retryable });
    expect(usage[0]).toMatchObject({ outcome: "failed", errorCode: code });
  });

  it("maps an egress denial to EGRESS_DENIED", async () => {
    const { gateway } = createGateway(async () => {
      throw new EgressPolicyError("EGRESS_DENIED", "DESTINATION_NOT_ALLOWED", "denied");
    });
    await expect(gateway.embed(["text"], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
  });

  it("reports cancellation instead of a generic failure", async () => {
    const controller = new AbortController();
    const { gateway, usage } = createGateway(async (_url, init) => {
      controller.abort();
      throw init.signal.reason ?? new Error("aborted");
    });
    await expect(gateway.embed(["text"], { credential: CREDENTIAL, signal: controller.signal })).rejects.toMatchObject({ code: "KB_CANCELLED" });
    expect(usage[0]).toMatchObject({ outcome: "cancelled" });
  });

  it("reports a provider timeout when the request deadline passes", async () => {
    const { gateway } = createGateway(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
      { KB_REQUEST_TIMEOUT_MS: "20" }
    );
    await expect(gateway.embed(["text"], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_PROVIDER_TIMEOUT" });
  });

  it("declares rerank unsupported without a configured endpoint and sends no request", async () => {
    const http = vi.fn<KnowledgeHttp>();
    const { gateway } = createGateway(http, { KB_RERANK_URL: "" });
    expect(gateway.capabilities.supportsRerank).toBe(false);
    await expect(gateway.rerank("q", ["d"], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_RERANK_UNSUPPORTED" });
    expect(http).not.toHaveBeenCalled();
  });

  it("sends the documented rerank body and parses relevance scores", async () => {
    const http = vi.fn<KnowledgeHttp>(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({
        model: "qwen3-rerank",
        input: { query: "return window", documents: ["a", "b"] },
        parameters: { top_n: 2, return_documents: false },
      });
      return jsonResponse({ output: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }, usage: { total_tokens: 12 } });
    });
    const { gateway, usage } = createGateway(http);
    await expect(gateway.rerank("return window", ["a", "b"], { credential: CREDENTIAL })).resolves.toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    expect(usage[0]).toMatchObject({ purpose: "rerank", model: "qwen3-rerank", totalTokens: 12 });
  });

  it("rejects a rerank response that references unknown documents", async () => {
    const { gateway } = createGateway(async () => jsonResponse({ output: { results: [{ index: 5, relevance_score: 0.9 }] } }));
    await expect(gateway.rerank("q", ["a"], { credential: CREDENTIAL })).rejects.toMatchObject({ code: "KB_PROVIDER_ERROR" });
  });
});
