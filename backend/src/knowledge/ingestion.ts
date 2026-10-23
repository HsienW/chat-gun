import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import type { KnowledgeConfig } from "./config.js";
import { chunkDocument, type PreparedCorpus } from "./corpus.js";
import { isKnowledgeError, KnowledgeError, type KnowledgeErrorCode } from "./errors.js";
import type { KnowledgeModelGateway } from "./model-gateway.js";
import type { IngestionRunStatus, KnowledgeStore } from "./store.js";

/** Failures that make every remaining document fail the same way end the run immediately. */
const FATAL_CODES: ReadonlySet<KnowledgeErrorCode> = new Set([
  "SECRET_REFERENCE_UNRESOLVABLE",
  "EGRESS_DENIED",
  "KB_CONFIG_INVALID",
  "KB_EMBEDDING_SPACE_MISMATCH",
  "KB_EMBEDDING_DIMENSION_MISMATCH",
  "KB_EMBEDDING_UNSUPPORTED",
]);

export interface IngestionInput {
  runId: string;
  tenantId: string;
  corpus: PreparedCorpus;
  store: KnowledgeStore;
  gateway: KnowledgeModelGateway;
  credential: string;
  config: KnowledgeConfig;
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface IngestionCounts {
  documents: number;
  publishedDocuments: number;
  unchangedDocuments: number;
  failedDocuments: number;
  rejectedDocuments: number;
  embeddedChunks: number;
  insertedChunks: number;
}

export interface IngestionResult {
  runId: string;
  status: Exclude<IngestionRunStatus, "running">;
  counts: IngestionCounts;
  failures: { sourceId: string; code: KnowledgeErrorCode }[];
  errorCode?: KnowledgeErrorCode;
}

export async function ingestCorpus(input: IngestionInput): Promise<IngestionResult> {
  const { store, gateway, config, corpus, tenantId, runId } = input;
  const counts: IngestionCounts = {
    documents: corpus.documents.length,
    publishedDocuments: 0,
    unchangedDocuments: 0,
    failedDocuments: 0,
    rejectedDocuments: corpus.rejected.length,
    embeddedChunks: 0,
    insertedChunks: 0,
  };
  const failures: IngestionResult["failures"] = [];
  const space = {
    embeddingSpaceId: config.embeddingSpaceId,
    provider: "qwen",
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
  };
  const policy = {
    version: config.chunkingPolicyVersion,
    targetChars: config.chunkTargetChars,
    overlapChars: config.chunkOverlapChars,
  };

  await store.ensureEmbeddingSpace(space);
  const corpusVersion = corpus.documents[0]?.corpusVersion ?? "empty";
  await store.beginRun({
    runId,
    tenantId,
    corpusVersion,
    embeddingSpaceId: space.embeddingSpaceId,
    chunkingPolicyVersion: policy.version,
  });

  const finish = async (status: IngestionResult["status"], errorCode?: KnowledgeErrorCode): Promise<IngestionResult> => {
    await store.finishRun(runId, status, { ...counts }, errorCode);
    return { runId, status, counts, failures, ...(errorCode ? { errorCode } : {}) };
  };

  for (const document of corpus.documents) {
    if (input.signal?.aborted) return finish("incomplete", "KB_CANCELLED");
    const chunks = chunkDocument(document, policy);
    try {
      const active = await store.findActiveSource(tenantId, document.sourceId);
      if (
        active !== undefined &&
        active.contentHash === document.contentHash &&
        (await store.countChunks(tenantId, document.sourceId)) === chunks.length
      ) {
        counts.unchangedDocuments += 1;
        continue;
      }
      const sourceVersion =
        active !== undefined && active.contentHash === document.contentHash
          ? active.sourceVersion
          : (active?.sourceVersion ?? 0) + 1;
      const embeddings = await gateway.embed(
        chunks.map((chunk) => chunk.content),
        { credential: input.credential, ...(input.signal ? { signal: input.signal } : {}), ...(input.context ? { context: input.context } : {}) }
      );
      counts.embeddedChunks += embeddings.length;
      const published = await store.publishSourceVersion(
        {
          tenantId,
          sourceId: document.sourceId,
          sourceVersion,
          sourceType: document.sourceType,
          title: document.title,
          dataClassification: document.dataClassification,
          contentHash: document.contentHash,
          corpusVersion: document.corpusVersion,
        },
        chunks.map((chunk, index) => ({
          tenantId,
          sourceId: document.sourceId,
          sourceVersion,
          chunkIndex: chunk.chunkIndex,
          offsetStart: chunk.offsetStart,
          offsetEnd: chunk.offsetEnd,
          content: chunk.content,
          contentHash: chunk.contentHash,
          dataClassification: document.dataClassification,
          ingestionRunId: runId,
          embeddingSpaceId: space.embeddingSpaceId,
          embedding: embeddings[index],
        }))
      );
      counts.insertedChunks += published.insertedChunks;
      counts.publishedDocuments += 1;
    } catch (error) {
      const failure = isKnowledgeError(error) ? error : new KnowledgeError("KB_PROVIDER_ERROR");
      if (failure.code === "KB_CANCELLED") return finish("incomplete", "KB_CANCELLED");
      counts.failedDocuments += 1;
      failures.push({ sourceId: document.sourceId, code: failure.code });
      if (FATAL_CODES.has(failure.code)) return finish("failed", failure.code);
    }
  }
  // Persist the first failure cause so an incomplete run stays diagnosable after stdout is gone.
  return counts.failedDocuments > 0 ? finish("incomplete", failures[0].code) : finish("completed");
}
