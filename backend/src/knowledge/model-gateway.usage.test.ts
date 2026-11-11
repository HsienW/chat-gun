import { afterEach, expect, it, vi } from "vitest";
import { datePartition } from "../platform/usage/ledger.js";
import { REGISTERED_GRAPH_IDS } from "../platform/usage/attribution.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("accounts embedding and rerank separately with graph attribution outside ExecutionContext", async () => {
  vi.stubEnv("USAGE_LEDGER_REDIS_URI", ""); vi.stubEnv("USAGE_LEDGER_TIME_ZONE", "UTC"); vi.resetModules();
  const { testKnowledgeConfig } = await import("./testing-fakes.js");
  const config = testKnowledgeConfig();
  vi.stubEnv("USAGE_PRICE_TABLE_JSON", JSON.stringify([
    { model: config.embeddingModel, callKind: "embedding" }, { model: config.rerankModel, callKind: "rerank" },
  ].map(model => ({ ...model, provider: "qwen", currency: "USD", inputPerMillion: "1", outputPerMillion: "0", source: "https://example.test/fixture", verifiedAt: "2026-11-02" }))));
  const { HttpKnowledgeModelGateway } = await import("./model-gateway.js");
  const gateway = new HttpKnowledgeModelGateway(config, async url => new Response(JSON.stringify(url.includes("embeddings")
    ? { data: [{ index: 0, embedding: new Array(64).fill(1) }], usage: { total_tokens: 6 } }
    : { output: { results: [{ index: 0, relevance_score: 0.9 }] }, usage: { total_tokens: 12 } }), { status: 200 }), () => {});
  const options = { credential: "fixture-not-a-secret", attribution: { graphId: REGISTERED_GRAPH_IDS.shoppingAssistant } };
  await gateway.embed(["fixture"], options);
  await gateway.rerank("fixture", ["document"], options);
  const { getUsageRuntime } = await import("../platform/usage/runtime.js"); const runtime = getUsageRuntime(); await runtime.writer.flush();
  const summary = await runtime.store.read(datePartition(new Date(), "UTC"));
  expect(summary).toMatchObject({ amountMicros: 18, unpricedCount: 0, currency: "USD" });
  expect(Object.values(summary.byGraphAndKind)).toEqual([
    { graphId: "shopping_assistant", callKind: "embedding", amountMicros: 6, unpricedCount: 0 },
    { graphId: "shopping_assistant", callKind: "rerank", amountMicros: 12, unpricedCount: 0 },
  ]);
  await runtime.close();
});
