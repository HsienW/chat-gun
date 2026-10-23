import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Queryable } from "../runtime/persistence/rows.js";
import { runKnowledgeMigrations } from "./migration-runner.js";
import { PgKnowledgeStore, type EmbeddingSpace, type KnowledgeChunkRecord, type KnowledgeSourceRecord } from "./store.js";
import { hashEmbedding } from "./testing-fakes.js";

type Recorded = { text: string; values: readonly unknown[] };

function recordingDb(rowsFor: (text: string) => Record<string, unknown>[] = () => []) {
  const calls: Recorded[] = [];
  const db: Queryable = {
    query: async <TResult extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      // Test double: rows are shaped per query text by the caller.
      const rows = rowsFor(text) as TResult[];
      return { rows, rowCount: rows.length };
    },
  };
  return { calls, db };
}

const SPACE: EmbeddingSpace = { embeddingSpaceId: "text-embedding-v4:1024", provider: "qwen", model: "text-embedding-v4", dimensions: 1024 };

describe("PgKnowledgeStore query contract", () => {
  it("recalls only active sources of the requested tenant and embedding space", async () => {
    const { db, calls } = recordingDb((text) => (text.includes("FROM kb_embedding_space") ? [{ dimensions: 1024, model: "text-embedding-v4" }] : []));
    await new PgKnowledgeStore(db).recall({ tenantId: "tenant-a", embeddingSpace: SPACE, queryEmbedding: new Array(1024).fill(0.1), limit: 5 });

    const recall = calls.find((call) => call.text.includes("FROM kb_chunk c"));
    expect(recall?.text).toContain("s.status = 'active'");
    expect(recall?.text).toContain("c.tenant_id = $1");
    expect(recall?.text).toContain("vector(1024)");
    expect(recall?.values[0]).toBe("tenant-a");
    expect(recall?.values[2]).toBe(SPACE.embeddingSpaceId);
  });

  it("rejects a query vector whose dimension differs from the space before querying", async () => {
    const { db, calls } = recordingDb();
    await expect(
      new PgKnowledgeStore(db).recall({ tenantId: "t", embeddingSpace: SPACE, queryEmbedding: [0.1, 0.2], limit: 5 })
    ).rejects.toMatchObject({ code: "KB_EMBEDDING_DIMENSION_MISMATCH" });
    expect(calls).toHaveLength(0);
  });

  it("refuses to recall from an unregistered embedding space", async () => {
    const { db } = recordingDb();
    await expect(
      new PgKnowledgeStore(db).recall({ tenantId: "t", embeddingSpace: SPACE, queryEmbedding: new Array(1024).fill(0.1), limit: 5 })
    ).rejects.toMatchObject({ code: "KB_EMBEDDING_SPACE_MISMATCH" });
  });

  it("maps driver failures to KB_STORE_UNAVAILABLE without leaking driver messages", async () => {
    const store = new PgKnowledgeStore({
      query: async () => {
        throw new Error("password authentication failed for user secret-user");
      },
    });
    const failure = await store.countChunks("t").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "KB_STORE_UNAVAILABLE" });
    expect(String((failure as Error).message)).not.toContain("secret-user");
  });
});

const LIVE_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;

/** Live pgvector evidence; runs only when a disposable knowledge database is provided. */
describe.skipIf(LIVE_URL === undefined || LIVE_URL === "")("PgKnowledgeStore against pgvector", () => {
  const pool = new Pool({ connectionString: LIVE_URL });
  const store = new PgKnowledgeStore(pool);
  const space: EmbeddingSpace = { embeddingSpaceId: "live-test:8", provider: "test", model: "live-test", dimensions: 8 };
  const tenant = `tenant-${Date.now()}`;
  const runId = `run-${Date.now()}`;

  function source(sourceId: string, sourceVersion: number, contentHash: string): KnowledgeSourceRecord {
    return { tenantId: tenant, sourceId, sourceVersion, sourceType: "policy", title: sourceId, dataClassification: "knowledge:internal-synthetic", contentHash, corpusVersion: "kb-live" };
  }
  function chunk(sourceId: string, sourceVersion: number, text: string, tenantId = tenant): KnowledgeChunkRecord {
    return {
      tenantId, sourceId, sourceVersion, chunkIndex: 0, offsetStart: 0, offsetEnd: text.length, content: text,
      contentHash: `${sourceId}-${sourceVersion}`, dataClassification: "knowledge:internal-synthetic",
      ingestionRunId: runId, embeddingSpaceId: space.embeddingSpaceId, embedding: hashEmbedding(text, 8),
    };
  }
  const recall = (text: string, tenantId = tenant) =>
    store.recall({ tenantId, embeddingSpace: space, queryEmbedding: hashEmbedding(text, 8), limit: 10 });

  beforeAll(async () => {
    await runKnowledgeMigrations(pool);
    await store.ensureEmbeddingSpace(space);
    await store.beginRun({ runId, tenantId: tenant, corpusVersion: "kb-live", embeddingSpaceId: space.embeddingSpaceId, chunkingPolicyVersion: "test" });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM kb_chunk WHERE tenant_id = ANY($1)", [[tenant, `${tenant}-b`]]);
    await pool.query("DELETE FROM kb_source WHERE tenant_id = ANY($1)", [[tenant, `${tenant}-b`]]);
    await pool.query("DELETE FROM kb_ingestion_run WHERE run_id = $1", [runId]);
    await pool.end();
  });

  it("publishes, supersedes, deletes and isolates tenants", async () => {
    await store.publishSourceVersion(source("policy-a", 1, "h1"), [chunk("policy-a", 1, "return within thirty days")]);
    await store.publishSourceVersion(source("policy-a", 2, "h2"), [chunk("policy-a", 2, "return within forty five days")]);
    const afterSupersede = await recall("return within days");
    expect(afterSupersede.map((item) => item.sourceVersion)).toEqual([2]);

    await store.publishSourceVersion({ ...source("policy-b", 1, "hb"), tenantId: `${tenant}-b` }, [chunk("policy-b", 1, "other tenant secret policy", `${tenant}-b`)]);
    expect((await recall("other tenant secret policy")).map((item) => item.sourceId)).not.toContain("policy-b");

    const removed = await store.deleteSource(tenant, "policy-a");
    expect(removed.removedChunks).toBe(1);
    expect(await recall("return within days")).toEqual([]);
  });

  /** Chunks left without an active source of the same version; must always be zero. */
  async function orphanChunks(sourceId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM kb_chunk c
       WHERE c.tenant_id = $1 AND c.source_id = $2 AND NOT EXISTS (
         SELECT 1 FROM kb_source s WHERE s.tenant_id = c.tenant_id AND s.source_id = c.source_id
           AND s.source_version = c.source_version AND s.status = 'active')`,
      [tenant, sourceId]
    );
    return (result.rows[0] as { n: number }).n;
  }

  it("never serves a deleted source to recalls racing the deletion", async () => {
    const text = "race window policy forty days";
    await store.publishSourceVersion(source("policy-race", 1, "hr"), [chunk("policy-race", 1, text)]);
    const racing = Array.from({ length: 20 }, () => recall(text));
    const deletion = store.deleteSource(tenant, "policy-race");
    const observed = await Promise.all(racing);
    await deletion;

    // Each racing recall saw either the committed source or nothing, never a partial state.
    for (const items of observed) {
      expect(items.filter((item) => item.sourceId === "policy-race").length).toBeLessThanOrEqual(1);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await recall(text)).map((item) => item.sourceId)).not.toContain("policy-race");
    }
    expect(await orphanChunks("policy-race")).toBe(0);
  });

  it("keeps source and chunks consistent when a new version races a deletion", async () => {
    for (let round = 0; round < 10; round += 1) {
      const sourceId = `policy-concurrent-${round}`;
      await store.publishSourceVersion(source(sourceId, 1, "v1"), [chunk(sourceId, 1, `concurrent policy round ${round} version one`)]);
      const outcomes = await Promise.allSettled([
        store.publishSourceVersion(source(sourceId, 2, "v2"), [chunk(sourceId, 2, `concurrent policy round ${round} version two`)]),
        store.deleteSource(tenant, sourceId),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

      const active = await pool.query(
        "SELECT source_version FROM kb_source WHERE tenant_id = $1 AND source_id = $2 AND status = 'active'",
        [tenant, sourceId]
      );
      const chunks = await pool.query("SELECT source_version FROM kb_chunk WHERE tenant_id = $1 AND source_id = $2", [tenant, sourceId]);
      // Whichever transaction committed last wins: either v2 is active with its chunk, or nothing remains.
      expect(active.rows.length).toBeLessThanOrEqual(1);
      expect(chunks.rows.length).toBe(active.rows.length);
      expect(await orphanChunks(sourceId)).toBe(0);
    }
  });
});
