import { z } from "zod";

import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import {
  egressPolicyErrorCodeSchema,
  observedEgressReasonCodeSchema,
} from "../runtime/tool-dispatch/egress-reason.js";
import type { KnowledgeConfig } from "./config.js";
import { isKnowledgeError, KnowledgeError } from "./errors.js";
import type { KnowledgeModelGateway } from "./model-gateway.js";
import { KNOWLEDGE_SOURCE_TYPES, type KnowledgeSourceType, type KnowledgeStore, type RecalledChunk } from "./store.js";

export const KB_SEARCH_RESULT_VERSION = "kb_search_result@1" as const;

export const RETRIEVAL_MODES = ["vector_rerank", "vector_only_configured", "vector_only_degraded"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

const retrievalEvidenceSchema = z
  .object({
    mode: z.enum(RETRIEVAL_MODES),
    embeddingSpaceId: z.string(),
    rerankModel: z.string().optional(),
    thresholdVersion: z.string(),
    configVersion: z.string(),
    candidateCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    degradation: z
      .object({
        reason: z.enum(["RERANK_UNAVAILABLE", "RERANK_PROVIDER_ERROR"]),
        egressErrorCode: egressPolicyErrorCodeSchema.optional(),
        egressReasonCode: observedEgressReasonCodeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const citationSchema = z
  .object({
    citationId: z.string().regex(/^c\d+$/u),
    chunkId: z.string(),
    sourceId: z.string(),
    sourceVersion: z.number().int().positive(),
    sourceType: z.enum(KNOWLEDGE_SOURCE_TYPES),
    title: z.string(),
    offsetStart: z.number().int().nonnegative(),
    offsetEnd: z.number().int().positive(),
  })
  .strict();

const evidenceChunkSchema = z
  .object({
    citationId: z.string(),
    chunkId: z.string(),
    content: z.string(),
    score: z.number(),
    rerankScore: z.number().optional(),
  })
  .strict();

export const kbSearchResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(KB_SEARCH_RESULT_VERSION),
      outcome: z.literal("evidence_found"),
      citations: z.array(citationSchema).min(1),
      chunks: z.array(evidenceChunkSchema).min(1),
      retrieval: retrievalEvidenceSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(KB_SEARCH_RESULT_VERSION),
      outcome: z.literal("no_source_found"),
      retrieval: retrievalEvidenceSchema,
    })
    .strict(),
]);

export type KbSearchResult = z.infer<typeof kbSearchResultSchema>;
export type RetrievalEvidence = z.infer<typeof retrievalEvidenceSchema>;
export type Citation = z.infer<typeof citationSchema>;

export interface KnowledgeSearchRequest {
  query: string;
  topK?: number;
  sourceTypes?: readonly KnowledgeSourceType[];
  /** Server-authoritative tenant from the execution context; never from tool input. */
  tenantId: string;
  /** "auto" uses rerank when available; "vector_only" is the configured comparison baseline. */
  strategy?: "auto" | "vector_only";
  store: KnowledgeStore;
  gateway: KnowledgeModelGateway;
  credential: string;
  config: KnowledgeConfig;
  signal?: AbortSignal;
  context?: ExecutionContext;
}

const DEFAULT_TOP_K = 5;

export interface ScoredCandidate {
  chunk: RecalledChunk;
  rerankScore?: number;
}

/** Ranked candidates before the evidence threshold; evaluation keeps these to calibrate thresholds. */
export interface RetrievedCandidates {
  mode: RetrievalMode;
  degradation?: RetrievalEvidence["degradation"];
  candidates: ScoredCandidate[];
}

export async function searchKnowledge(request: KnowledgeSearchRequest): Promise<KbSearchResult> {
  return buildSearchResult(await retrieveCandidates(request), request.config, request.topK);
}

/** Applies the versioned evidence threshold and binds citations; shared by runtime and evaluation. */
export function buildSearchResult(retrieved: RetrievedCandidates, config: KnowledgeConfig, topK?: number): KbSearchResult {
  const { mode, degradation, candidates } = retrieved;
  const passed = candidates.filter((item) =>
    mode === "vector_rerank"
      ? (item.rerankScore ?? 0) >= config.rerankThreshold
      : item.chunk.similarity >= config.vectorThreshold
  );
  const selected = passed.slice(0, Math.min(topK ?? DEFAULT_TOP_K, 20));
  const retrieval: RetrievalEvidence = {
    mode,
    embeddingSpaceId: config.embeddingSpaceId,
    ...(mode === "vector_rerank" ? { rerankModel: config.rerankModel } : {}),
    thresholdVersion: config.thresholdVersion,
    configVersion: config.configVersion,
    candidateCount: candidates.length,
    passedCount: passed.length,
    ...(degradation ? { degradation } : {}),
  };

  if (selected.length === 0) {
    return { schemaVersion: KB_SEARCH_RESULT_VERSION, outcome: "no_source_found", retrieval };
  }
  return {
    schemaVersion: KB_SEARCH_RESULT_VERSION,
    outcome: "evidence_found",
    citations: selected.map(({ chunk }, index) => ({
      citationId: `c${index + 1}`,
      chunkId: chunk.chunkId,
      sourceId: chunk.sourceId,
      sourceVersion: chunk.sourceVersion,
      sourceType: chunk.sourceType,
      title: chunk.title,
      offsetStart: chunk.offsetStart,
      offsetEnd: chunk.offsetEnd,
    })),
    chunks: selected.map(({ chunk, rerankScore }, index) => ({
      citationId: `c${index + 1}`,
      chunkId: chunk.chunkId,
      content: chunk.content,
      score: chunk.similarity,
      ...(rerankScore !== undefined ? { rerankScore } : {}),
    })),
    retrieval,
  };
}

/** Embeds the query, recalls candidates and reranks them (or records why rerank was skipped). */
export async function retrieveCandidates(request: KnowledgeSearchRequest): Promise<RetrievedCandidates> {
  const { config, gateway, store } = request;
  const callOptions = {
    credential: request.credential,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.context ? { context: request.context } : {}),
  };
  const [queryEmbedding] = await gateway.embed([request.query], callOptions);
  if (request.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
  const candidates = await store.recall({
    tenantId: request.tenantId,
    embeddingSpace: {
      embeddingSpaceId: config.embeddingSpaceId,
      provider: "qwen",
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
    },
    queryEmbedding,
    limit: config.candidateCount,
    ...(request.sourceTypes ? { sourceTypes: request.sourceTypes } : {}),
  });

  let mode: RetrievalMode = request.strategy === "vector_only" ? "vector_only_configured" : "vector_rerank";
  let degradation: RetrievalEvidence["degradation"];
  let scored: ScoredCandidate[] = candidates.map((chunk) => ({ chunk }));

  if (mode === "vector_rerank" && candidates.length > 0) {
    try {
      const scores = await gateway.rerank(
        request.query,
        candidates.map((chunk) => chunk.content),
        { ...callOptions, topN: candidates.length }
      );
      scored = scores
        .map((score) => ({ chunk: candidates[score.index], rerankScore: score.score }))
        .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0));
    } catch (error) {
      if (request.signal?.aborted || (isKnowledgeError(error) && error.code === "KB_CANCELLED")) {
        throw new KnowledgeError("KB_CANCELLED");
      }
      // Rerank failure degrades to recall-only; the degradation is always recorded in the evidence.
      mode = "vector_only_degraded";
      degradation = {
        reason: isKnowledgeError(error) && error.code === "KB_RERANK_UNSUPPORTED" ? "RERANK_UNAVAILABLE" : "RERANK_PROVIDER_ERROR",
        ...(isKnowledgeError(error) && (error.code === "EGRESS_DENIED" || error.code === "EGRESS_POLICY_UNAVAILABLE")
          ? { egressErrorCode: error.code, ...(error.egressReasonCode ? { egressReasonCode: error.egressReasonCode } : {}) }
          : {}),
      };
    }
  }

  return { mode, ...(degradation ? { degradation } : {}), candidates: scored };
}
