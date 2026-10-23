import { KnowledgeError } from "./errors.js";
import {
  chunkIdFor,
  KNOWLEDGE_SOURCE_TYPES,
  type ChunkNaturalKey,
  type EmbeddingSpace,
  type IngestionRunStatus,
  type KnowledgeChunkRecord,
  type KnowledgeSourceRecord,
  type KnowledgeStore,
  type RecallQuery,
  type RecalledChunk,
} from "./store.js";

type SourceRow = KnowledgeSourceRecord & { status: "active" | "superseded" | "deleted" };

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * Deterministic store with the same visibility rules as PgKnowledgeStore: only active source
 * versions are recalled, recall is tenant-scoped, and publication is all-or-nothing.
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  readonly spaces = new Map<string, EmbeddingSpace>();
  readonly sources: SourceRow[] = [];
  readonly chunks = new Map<string, KnowledgeChunkRecord & { chunkId: string }>();
  readonly runs = new Map<string, { status: IngestionRunStatus; counts: Record<string, number>; errorCode?: string }>();
  failNextPublish = false;

  async ensureEmbeddingSpace(space: EmbeddingSpace): Promise<void> {
    const existing = this.spaces.get(space.embeddingSpaceId);
    if (existing !== undefined && (existing.dimensions !== space.dimensions || existing.model !== space.model)) {
      throw new KnowledgeError("KB_EMBEDDING_SPACE_MISMATCH");
    }
    this.spaces.set(space.embeddingSpaceId, space);
  }

  async beginRun(input: { runId: string }): Promise<void> {
    this.runs.set(input.runId, { status: "running", counts: {} });
  }

  async finishRun(runId: string, status: Exclude<IngestionRunStatus, "running">, counts: Record<string, number>, errorCode?: string): Promise<void> {
    this.runs.set(runId, { status, counts, ...(errorCode ? { errorCode } : {}) });
  }

  async findActiveSource(tenantId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined> {
    const row = this.sources.find((source) => source.tenantId === tenantId && source.sourceId === sourceId && source.status === "active");
    if (row === undefined) return undefined;
    const { status: _status, ...record } = row;
    return record;
  }

  async publishSourceVersion(source: KnowledgeSourceRecord, chunks: readonly KnowledgeChunkRecord[]): Promise<{ insertedChunks: number }> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new KnowledgeError("KB_STORE_UNAVAILABLE");
    }
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.tenantId === source.tenantId && chunk.sourceId === source.sourceId && chunk.sourceVersion !== source.sourceVersion) {
        this.chunks.delete(chunkId);
      }
    }
    for (const row of this.sources) {
      if (row.tenantId === source.tenantId && row.sourceId === source.sourceId && row.status === "active") {
        row.status = row.sourceVersion === source.sourceVersion ? "active" : "superseded";
      }
    }
    if (!this.sources.some((row) => row.tenantId === source.tenantId && row.sourceId === source.sourceId && row.sourceVersion === source.sourceVersion)) {
      this.sources.push({ ...source, status: "active" });
    }
    let inserted = 0;
    for (const chunk of chunks) {
      const chunkId = chunkIdFor(chunk);
      if (!this.chunks.has(chunkId)) {
        this.chunks.set(chunkId, { ...chunk, chunkId });
        inserted += 1;
      }
    }
    return { insertedChunks: inserted };
  }

  async hasChunk(key: ChunkNaturalKey): Promise<boolean> {
    return this.chunks.has(chunkIdFor(key));
  }

  async deleteSource(tenantId: string, sourceId: string): Promise<{ removedChunks: number }> {
    let removedChunks = 0;
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.tenantId === tenantId && chunk.sourceId === sourceId) {
        this.chunks.delete(chunkId);
        removedChunks += 1;
      }
    }
    for (const row of this.sources) {
      if (row.tenantId === tenantId && row.sourceId === sourceId) row.status = "deleted";
    }
    return { removedChunks };
  }

  async recall(query: RecallQuery): Promise<RecalledChunk[]> {
    if (query.queryEmbedding.length !== query.embeddingSpace.dimensions) {
      throw new KnowledgeError("KB_EMBEDDING_DIMENSION_MISMATCH");
    }
    const registered = this.spaces.get(query.embeddingSpace.embeddingSpaceId);
    if (registered === undefined || registered.dimensions !== query.embeddingSpace.dimensions) {
      throw new KnowledgeError("KB_EMBEDDING_SPACE_MISMATCH");
    }
    const sourceTypes = new Set(query.sourceTypes?.length ? query.sourceTypes : KNOWLEDGE_SOURCE_TYPES);
    return [...this.chunks.values()]
      .flatMap((chunk) => {
        const source = this.sources.find(
          (row) => row.tenantId === chunk.tenantId && row.sourceId === chunk.sourceId && row.sourceVersion === chunk.sourceVersion
        );
        if (
          source === undefined ||
          source.status !== "active" ||
          chunk.tenantId !== query.tenantId ||
          chunk.embeddingSpaceId !== query.embeddingSpace.embeddingSpaceId ||
          !sourceTypes.has(source.sourceType)
        ) {
          return [];
        }
        return [{
          chunkId: chunk.chunkId,
          sourceId: chunk.sourceId,
          sourceVersion: chunk.sourceVersion,
          sourceType: source.sourceType,
          title: source.title,
          chunkIndex: chunk.chunkIndex,
          offsetStart: chunk.offsetStart,
          offsetEnd: chunk.offsetEnd,
          content: chunk.content,
          similarity: cosine(chunk.embedding, query.queryEmbedding),
        }];
      })
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, query.limit);
  }

  async countChunks(tenantId: string, sourceId?: string): Promise<number> {
    return [...this.chunks.values()].filter(
      (chunk) => chunk.tenantId === tenantId && (sourceId === undefined || chunk.sourceId === sourceId)
    ).length;
  }
}
