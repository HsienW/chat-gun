import { describe, expect, it } from "vitest";

import { prepareCorpus, type PreparedCorpus } from "./corpus.js";
import { KnowledgeError } from "./errors.js";
import { InMemoryKnowledgeStore } from "./in-memory-store.js";
import { ingestCorpus } from "./ingestion.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "./testing-fakes.js";

const config = testKnowledgeConfig();
const TENANT = "tenant-a";

function corpusOf(descriptions: Record<string, string>): PreparedCorpus {
  return prepareCorpus({
    products: Object.entries(descriptions).map(([sourceId, description]) => ({
      synthetic: true,
      corpusVersion: "kb-test",
      generatedAt: "2026-10-23",
      sourceId,
      sourceType: "product",
      title: sourceId,
      description,
    })),
    policyMarkdown: [],
  });
}

function run(store: InMemoryKnowledgeStore, gateway: FakeKnowledgeModelGateway, corpus: PreparedCorpus, runId: string, signal?: AbortSignal) {
  return ingestCorpus({ runId, tenantId: TENANT, corpus, store, gateway, credential: "test-credential", config, ...(signal ? { signal } : {}) });
}

describe("knowledge ingestion", () => {
  it("publishes every document with provenance and records a completed run", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    const result = await run(store, gateway, corpusOf({ "product-a": "Red mug.", "product-b": "Blue bottle." }), "run-1");

    expect(result.status).toBe("completed");
    expect(result.counts).toMatchObject({ publishedDocuments: 2, insertedChunks: 2, failedDocuments: 0 });
    expect(store.runs.get("run-1")?.status).toBe("completed");
    for (const chunk of store.chunks.values()) {
      expect(chunk).toMatchObject({
        tenantId: TENANT,
        sourceVersion: 1,
        dataClassification: "knowledge:internal-synthetic",
        ingestionRunId: "run-1",
        embeddingSpaceId: config.embeddingSpaceId,
      });
    }
  });

  it("treats a duplicate submission as a no-op without calling the embedding model", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    const corpus = corpusOf({ "product-a": "Red mug.", "product-b": "Blue bottle." });
    await run(store, gateway, corpus, "run-1");
    const embedCallsAfterFirstRun = gateway.embedCalls.length;

    const second = await run(store, gateway, corpus, "run-2");
    expect(second.status).toBe("completed");
    expect(second.counts).toMatchObject({ unchangedDocuments: 2, publishedDocuments: 0, embeddedChunks: 0 });
    expect(gateway.embedCalls).toHaveLength(embedCallsAfterFirstRun);
    expect(store.chunks.size).toBe(2);
  });

  it("marks the run incomplete on a partial failure without publishing the failed document, then resumes", async () => {
    const store = new InMemoryKnowledgeStore();
    let failing = true;
    const gateway = new FakeKnowledgeModelGateway({
      dimensions: 64,
      failEmbeddingFor: (text) => (failing && text.includes("product-b") ? new KnowledgeError("KB_PROVIDER_TIMEOUT") : undefined),
    });
    const corpus = corpusOf({ "product-a": "Red mug.", "product-b": "Blue bottle.", "product-c": "Green plate." });

    const first = await run(store, gateway, corpus, "run-1");
    expect(first.status).toBe("incomplete");
    expect(first.failures).toEqual([{ sourceId: "product-b", code: "KB_PROVIDER_TIMEOUT" }]);
    expect(store.runs.get("run-1")).toMatchObject({ status: "incomplete", errorCode: "KB_PROVIDER_TIMEOUT" });
    expect(await store.findActiveSource(TENANT, "product-b")).toBeUndefined();
    expect(await store.countChunks(TENANT, "product-b")).toBe(0);
    expect(await store.countChunks(TENANT, "product-c")).toBe(1);

    failing = false;
    const resumed = await run(store, gateway, corpus, "run-2");
    expect(resumed.status).toBe("completed");
    expect(resumed.counts).toMatchObject({ unchangedDocuments: 2, publishedDocuments: 1, embeddedChunks: 1 });
  });

  it("keeps the previous version active when publication fails", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    await run(store, gateway, corpusOf({ "product-a": "Red mug." }), "run-1");
    store.failNextPublish = true;

    const result = await run(store, gateway, corpusOf({ "product-a": "Red mug, now ceramic." }), "run-2");
    expect(result.status).toBe("incomplete");
    expect((await store.findActiveSource(TENANT, "product-a"))?.sourceVersion).toBe(1);
  });

  it("supersedes a changed source with a new version and removes the old chunks", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    await run(store, gateway, corpusOf({ "product-a": "Red mug." }), "run-1");
    await run(store, gateway, corpusOf({ "product-a": "Red mug, now ceramic." }), "run-2");

    expect((await store.findActiveSource(TENANT, "product-a"))?.sourceVersion).toBe(2);
    expect([...store.chunks.values()].map((chunk) => chunk.sourceVersion)).toEqual([2]);
  });

  it("stops the run as failed on a fatal credential or egress failure", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64, failEmbeddingFor: () => new KnowledgeError("EGRESS_DENIED") });
    const result = await run(store, gateway, corpusOf({ "product-a": "Red mug.", "product-b": "Blue bottle." }), "run-1");
    expect(result).toMatchObject({ status: "failed", errorCode: "EGRESS_DENIED", counts: { failedDocuments: 1 } });
    expect(gateway.embedCalls).toHaveLength(1);
  });

  it("stops the run when the egress policy cannot finish evaluating", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({
      dimensions: 64,
      failEmbeddingFor: () => new KnowledgeError("EGRESS_POLICY_UNAVAILABLE", "unavailable", "DNS_RESOLUTION_FAILED"),
    });
    const result = await run(store, gateway, corpusOf({ "product-a": "Red mug.", "product-b": "Blue bottle." }), "run-1");
    expect(result).toMatchObject({ status: "failed", errorCode: "EGRESS_POLICY_UNAVAILABLE", counts: { failedDocuments: 1 } });
    expect(gateway.embedCalls).toHaveLength(1);
  });

  it("ends as incomplete when cancelled", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    const controller = new AbortController();
    controller.abort();
    const result = await run(store, gateway, corpusOf({ "product-a": "Red mug." }), "run-1", controller.signal);
    expect(result).toMatchObject({ status: "incomplete", errorCode: "KB_CANCELLED" });
    expect(store.chunks.size).toBe(0);
  });

  it("rejects a mismatched embedding space before ingesting", async () => {
    const store = new InMemoryKnowledgeStore();
    await store.ensureEmbeddingSpace({ embeddingSpaceId: config.embeddingSpaceId, provider: "qwen", model: config.embeddingModel, dimensions: 32 });
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    await expect(run(store, gateway, corpusOf({ "product-a": "Red mug." }), "run-1")).rejects.toMatchObject({ code: "KB_EMBEDDING_SPACE_MISMATCH" });
  });
});
