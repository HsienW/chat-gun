import { createHash } from "node:crypto";

import type { Queryable } from "../runtime/persistence/rows.js";
import { KnowledgeError } from "./errors.js";

export const KNOWLEDGE_SOURCE_TYPES = ["product", "policy", "faq"] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export interface EmbeddingSpace {
  embeddingSpaceId: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface KnowledgeSourceRecord {
  tenantId: string;
  sourceId: string;
  sourceVersion: number;
  sourceType: KnowledgeSourceType;
  title: string;
  dataClassification: string;
  contentHash: string;
  corpusVersion: string;
}

export interface KnowledgeChunkRecord {
  tenantId: string;
  sourceId: string;
  sourceVersion: number;
  chunkIndex: number;
  offsetStart: number;
  offsetEnd: number;
  content: string;
  contentHash: string;
  dataClassification: string;
  ingestionRunId: string;
  embeddingSpaceId: string;
  embedding: readonly number[];
}

export interface RecalledChunk {
  chunkId: string;
  sourceId: string;
  sourceVersion: number;
  sourceType: KnowledgeSourceType;
  title: string;
  chunkIndex: number;
  offsetStart: number;
  offsetEnd: number;
  content: string;
  similarity: number;
}

export interface RecallQuery {
  tenantId: string;
  embeddingSpace: EmbeddingSpace;
  queryEmbedding: readonly number[];
  limit: number;
  sourceTypes?: readonly KnowledgeSourceType[];
}

export type IngestionRunStatus = "running" | "completed" | "failed" | "incomplete";

export interface ChunkNaturalKey {
  tenantId: string;
  sourceId: string;
  sourceVersion: number;
  chunkIndex: number;
  contentHash: string;
  embeddingSpaceId: string;
}

export interface KnowledgeStore {
  ensureEmbeddingSpace(space: EmbeddingSpace): Promise<void>;
  beginRun(input: { runId: string; tenantId: string; corpusVersion: string; embeddingSpaceId: string; chunkingPolicyVersion: string }): Promise<void>;
  finishRun(runId: string, status: Exclude<IngestionRunStatus, "running">, counts: Record<string, number>, errorCode?: string): Promise<void>;
  /** Returns the active version of a source, if any. */
  findActiveSource(tenantId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined>;
  /**
   * Makes `source` the active version together with all of its chunks in one transaction:
   * chunks of earlier versions are removed, so no reader ever sees a partially embedded version.
   */
  publishSourceVersion(source: KnowledgeSourceRecord, chunks: readonly KnowledgeChunkRecord[]): Promise<{ insertedChunks: number }>;
  hasChunk(key: ChunkNaturalKey): Promise<boolean>;
  /** Marks the source deleted and removes all derived chunks in one transaction. */
  deleteSource(tenantId: string, sourceId: string): Promise<{ removedChunks: number }>;
  recall(query: RecallQuery): Promise<RecalledChunk[]>;
  countChunks(tenantId: string, sourceId?: string): Promise<number>;
}

export function chunkIdFor(key: ChunkNaturalKey): string {
  return `chk_${createHash("sha256")
    .update([key.tenantId, key.sourceId, key.sourceVersion, key.chunkIndex, key.contentHash, key.embeddingSpaceId].join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function vectorLiteral(values: readonly number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new KnowledgeError("KB_EMBEDDING_DIMENSION_MISMATCH", "Embedding contains non-finite values");
  }
  return `[${values.join(",")}]`;
}

/** Queryable that can run statements inside one transaction (pg.Pool and pg.PoolClient both qualify). */
export interface TransactionalQueryable extends Queryable {
  connect?: () => Promise<Queryable & { release: () => void }>;
}

async function inTransaction<T>(db: TransactionalQueryable, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = db.connect ? await db.connect() : undefined;
  const target = client ?? db;
  try {
    await target.query("BEGIN");
    const result = await work(target);
    await target.query("COMMIT");
    return result;
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

/**
 * Serializes publish and delete of one source. Without it, a delete racing a publish keeps its
 * pre-commit snapshot for kb_chunk, misses the new version's chunks, then marks that version deleted.
 */
async function lockSource(client: Queryable, tenantId: string, sourceId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`kb_source:${tenantId}:${sourceId}`]);
}

async function insertChunkRows(client: Queryable, chunks: readonly KnowledgeChunkRecord[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks) {
    const result = await client.query(
      `INSERT INTO kb_chunk (tenant_id, chunk_id, source_id, source_version, chunk_index, offset_start, offset_end,
                             content, content_hash, data_classification, ingestion_run_id, embedding_space_id, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector)
       ON CONFLICT DO NOTHING`,
      [
        chunk.tenantId,
        chunkIdFor(chunk),
        chunk.sourceId,
        chunk.sourceVersion,
        chunk.chunkIndex,
        chunk.offsetStart,
        chunk.offsetEnd,
        chunk.content,
        chunk.contentHash,
        chunk.dataClassification,
        chunk.ingestionRunId,
        chunk.embeddingSpaceId,
        vectorLiteral(chunk.embedding),
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError("KB_STORE_UNAVAILABLE", "Knowledge store operation failed");
  }
}

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: TransactionalQueryable) {}

  ensureEmbeddingSpace(space: EmbeddingSpace): Promise<void> {
    return guarded(async () => {
      const existing = await this.db.query<{ dimensions: number; model: string }>(
        "SELECT dimensions, model FROM kb_embedding_space WHERE embedding_space_id = $1",
        [space.embeddingSpaceId]
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.dimensions !== space.dimensions || row.model !== space.model) {
          throw new KnowledgeError("KB_EMBEDDING_SPACE_MISMATCH", "Embedding space is registered with a different model or dimension");
        }
        return;
      }
      await this.db.query(
        "INSERT INTO kb_embedding_space (embedding_space_id, provider, model, dimensions) VALUES ($1, $2, $3, $4)",
        [space.embeddingSpaceId, space.provider, space.model, space.dimensions]
      );
    });
  }

  beginRun(input: { runId: string; tenantId: string; corpusVersion: string; embeddingSpaceId: string; chunkingPolicyVersion: string }): Promise<void> {
    return guarded(async () => {
      await this.db.query(
        `INSERT INTO kb_ingestion_run (run_id, tenant_id, corpus_version, embedding_space_id, chunking_policy_version, status)
         VALUES ($1, $2, $3, $4, $5, 'running')
         ON CONFLICT (run_id) DO UPDATE SET status = 'running', completed_at = NULL, error_code = NULL`,
        [input.runId, input.tenantId, input.corpusVersion, input.embeddingSpaceId, input.chunkingPolicyVersion]
      );
    });
  }

  finishRun(runId: string, status: Exclude<IngestionRunStatus, "running">, counts: Record<string, number>, errorCode?: string): Promise<void> {
    return guarded(async () => {
      await this.db.query(
        "UPDATE kb_ingestion_run SET status = $2, counts = $3::jsonb, error_code = $4, completed_at = NOW() WHERE run_id = $1",
        [runId, status, JSON.stringify(counts), errorCode ?? null]
      );
    });
  }

  findActiveSource(tenantId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined> {
    return guarded(async () => {
      const result = await this.db.query<Record<string, unknown>>(
        `SELECT tenant_id, source_id, source_version, source_type, title, data_classification, content_hash, corpus_version
         FROM kb_source WHERE tenant_id = $1 AND source_id = $2 AND status = 'active'`,
        [tenantId, sourceId]
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            tenantId: String(row.tenant_id),
            sourceId: String(row.source_id),
            sourceVersion: Number(row.source_version),
            sourceType: row.source_type as KnowledgeSourceType,
            title: String(row.title),
            dataClassification: String(row.data_classification),
            contentHash: String(row.content_hash),
            corpusVersion: String(row.corpus_version),
          };
    });
  }

  publishSourceVersion(
    source: KnowledgeSourceRecord,
    chunks: readonly KnowledgeChunkRecord[]
  ): Promise<{ insertedChunks: number }> {
    if (chunks.some((chunk) => chunk.tenantId !== source.tenantId || chunk.sourceId !== source.sourceId || chunk.sourceVersion !== source.sourceVersion)) {
      return Promise.reject(new KnowledgeError("KB_SOURCE_PROVENANCE_MISSING", "Chunk provenance does not match its source version"));
    }
    return guarded(() =>
      inTransaction(this.db, async (client) => {
        await lockSource(client, source.tenantId, source.sourceId);
        await client.query(
          `DELETE FROM kb_chunk WHERE tenant_id = $1 AND source_id = $2 AND source_version <> $3`,
          [source.tenantId, source.sourceId, source.sourceVersion]
        );
        await client.query(
          `UPDATE kb_source SET status = 'superseded', updated_at = NOW()
           WHERE tenant_id = $1 AND source_id = $2 AND status = 'active' AND source_version <> $3`,
          [source.tenantId, source.sourceId, source.sourceVersion]
        );
        await client.query(
          `INSERT INTO kb_source (tenant_id, source_id, source_version, source_type, title, data_classification, content_hash, corpus_version, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
           ON CONFLICT (tenant_id, source_id, source_version)
           DO UPDATE SET status = 'active', updated_at = NOW()`,
          [
            source.tenantId,
            source.sourceId,
            source.sourceVersion,
            source.sourceType,
            source.title,
            source.dataClassification,
            source.contentHash,
            source.corpusVersion,
          ]
        );
        return { insertedChunks: await insertChunkRows(client, chunks) };
      })
    );
  }

  hasChunk(key: ChunkNaturalKey): Promise<boolean> {
    return guarded(async () => {
      const result = await this.db.query(
        "SELECT 1 FROM kb_chunk WHERE tenant_id = $1 AND chunk_id = $2",
        [key.tenantId, chunkIdFor(key)]
      );
      return result.rows.length > 0;
    });
  }

  deleteSource(tenantId: string, sourceId: string): Promise<{ removedChunks: number }> {
    return guarded(() =>
      inTransaction(this.db, async (client) => {
        await lockSource(client, tenantId, sourceId);
        const removed = await client.query(
          "DELETE FROM kb_chunk WHERE tenant_id = $1 AND source_id = $2",
          [tenantId, sourceId]
        );
        await client.query(
          "UPDATE kb_source SET status = 'deleted', updated_at = NOW() WHERE tenant_id = $1 AND source_id = $2 AND status <> 'deleted'",
          [tenantId, sourceId]
        );
        return { removedChunks: removed.rowCount ?? 0 };
      })
    );
  }

  recall(query: RecallQuery): Promise<RecalledChunk[]> {
    const { embeddingSpace, queryEmbedding } = query;
    if (queryEmbedding.length !== embeddingSpace.dimensions) {
      return Promise.reject(
        new KnowledgeError("KB_EMBEDDING_DIMENSION_MISMATCH", "Query embedding dimension differs from the embedding space")
      );
    }
    // The dimension is a validated integer from versioned configuration, never user input.
    const dimensions = Number(embeddingSpace.dimensions);
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      return Promise.reject(new KnowledgeError("KB_CONFIG_INVALID", "Invalid embedding dimension"));
    }
    const vectorType = `vector(${dimensions})`;
    return guarded(async () => {
      const space = await this.db.query<{ dimensions: number; model: string }>(
        "SELECT dimensions, model FROM kb_embedding_space WHERE embedding_space_id = $1",
        [embeddingSpace.embeddingSpaceId]
      );
      const registered = space.rows[0];
      if (registered === undefined || registered.dimensions !== dimensions || registered.model !== embeddingSpace.model) {
        throw new KnowledgeError("KB_EMBEDDING_SPACE_MISMATCH", "Embedding space is not ready for retrieval");
      }
      const sourceTypes = query.sourceTypes?.length ? [...query.sourceTypes] : [...KNOWLEDGE_SOURCE_TYPES];
      const result = await this.db.query<Record<string, unknown>>(
        `SELECT c.chunk_id, c.source_id, c.source_version, s.source_type, s.title, c.chunk_index,
                c.offset_start, c.offset_end, c.content,
                1 - ((c.embedding::${vectorType}) <=> ($2::${vectorType})) AS similarity
         FROM kb_chunk c
         JOIN kb_source s
           ON s.tenant_id = c.tenant_id AND s.source_id = c.source_id AND s.source_version = c.source_version
         WHERE c.tenant_id = $1
           AND c.embedding_space_id = $3
           AND s.status = 'active'
           AND s.source_type = ANY($4::text[])
         ORDER BY (c.embedding::${vectorType}) <=> ($2::${vectorType})
         LIMIT $5`,
        [query.tenantId, vectorLiteral(queryEmbedding), embeddingSpace.embeddingSpaceId, sourceTypes, query.limit]
      );
      return result.rows.map((row) => ({
        chunkId: String(row.chunk_id),
        sourceId: String(row.source_id),
        sourceVersion: Number(row.source_version),
        sourceType: row.source_type as KnowledgeSourceType,
        title: String(row.title),
        chunkIndex: Number(row.chunk_index),
        offsetStart: Number(row.offset_start),
        offsetEnd: Number(row.offset_end),
        content: String(row.content),
        similarity: Number(row.similarity),
      }));
    });
  }

  countChunks(tenantId: string, sourceId?: string): Promise<number> {
    return guarded(async () => {
      const result = await this.db.query<{ count: string }>(
        sourceId === undefined
          ? "SELECT COUNT(*)::text AS count FROM kb_chunk WHERE tenant_id = $1"
          : "SELECT COUNT(*)::text AS count FROM kb_chunk WHERE tenant_id = $1 AND source_id = $2",
        sourceId === undefined ? [tenantId] : [tenantId, sourceId]
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }
}
