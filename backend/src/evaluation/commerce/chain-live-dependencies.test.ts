import { describe, expect, it } from "vitest";

import { prepareCorpus } from "../../knowledge/corpus.js";
import { InMemoryKnowledgeStore } from "../../knowledge/in-memory-store.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "../../knowledge/testing-fakes.js";
import { KB_SEARCH_SECRET_REFERENCE } from "../../tools/kb-search.js";
import { createLiveChainKnowledge } from "./chain-live-dependencies.js";

describe("live chain knowledge wiring (design §20.5 B1)", () => {
  const config = testKnowledgeConfig();

  function wiring() {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    const store = new InMemoryKnowledgeStore();
    const knowledge = createLiveChainKnowledge({
      db: {
        query: async (text, values = []) => {
          statements.push({ text, values });
          return { rows: [], rowCount: 0 };
        },
      },
      store,
      gateway: new FakeKnowledgeModelGateway({ dimensions: config.embeddingDimensions }),
      credential: "test-credential",
      config,
      corpus: prepareCorpus({ products: [], policyMarkdown: [] }),
    });
    return { knowledge, statements };
  }

  it("purges only the evaluation tenant's knowledge rows, chunks first", async () => {
    const { knowledge, statements } = wiring();

    await knowledge.purge("chain-eval-1-live");

    expect(statements.map((statement) => statement.text.match(/DELETE FROM (\w+)/u)?.[1])).toEqual(["kb_chunk", "kb_source", "kb_ingestion_run"]);
    for (const statement of statements) {
      expect(statement.text).toMatch(/WHERE tenant_id = \$1$/u);
      expect(statement.values).toEqual(["chain-eval-1-live"]);
    }
  });

  it("refuses to purge a tenant that is not a live evaluation tenant", async () => {
    const { knowledge, statements } = wiring();

    await expect(knowledge.purge("public")).rejects.toMatchObject({ code: "CHAIN_LIVE_TENANT_INVALID" });
    await expect(knowledge.purge("synthetic-tenant")).rejects.toMatchObject({ code: "CHAIN_LIVE_TENANT_INVALID" });
    expect(statements).toEqual([]);
  });

  it("resolves only kb_search's own credential reference", async () => {
    const previous = process.env[KB_SEARCH_SECRET_REFERENCE.secretName];
    process.env[KB_SEARCH_SECRET_REFERENCE.secretName] = "from-env";
    try {
      const { knowledge } = wiring();
      const context = { principal: { tenantId: "t" } } as never;

      await expect(knowledge.secretBroker.resolve(KB_SEARCH_SECRET_REFERENCE, context)).resolves.toMatchObject({ value: "from-env" });
      await expect(
        knowledge.secretBroker.resolve({ secretRef: "env:OTHER", secretName: "OTHER", scope: "tool:kb_search" }, context)
      ).rejects.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env[KB_SEARCH_SECRET_REFERENCE.secretName];
      else process.env[KB_SEARCH_SECRET_REFERENCE.secretName] = previous;
    }
  });
});
