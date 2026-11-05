import { getBooleanEnv } from "../platform/env.js";
import { recordMetric } from "../platform/observability.js";
import { readKnowledgeConfig } from "../knowledge/config.js";
import { createKnowledgeSecretBroker, createSystemExecutionContext, KNOWLEDGE_MODEL_SECRET } from "../knowledge/connection.js";
import { HttpKnowledgeModelGateway, type RerankScore } from "../knowledge/model-gateway.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";

/**
 * Optional cross-encoder reranking of deep research search candidates.
 *
 * Off by default (DEEP_RESEARCH_SOURCE_RERANK=false). When on, title + snippet of every deduped
 * candidate is scored against the research question with the knowledge rerank model
 * (qwen3-rerank via KB_RERANK_URL). Any failure — missing config, credential, egress denial,
 * timeout or a malformed response — keeps the rule-based order, so the graph never loses sources
 * because the reranker is unavailable.
 */

export const SOURCE_RERANK_ENV = "DEEP_RESEARCH_SOURCE_RERANK";
const MAX_DOCUMENT_CHARS = 1_000;

export interface RankCandidate {
  title: string;
  url: string;
  snippet: string;
  score: number;
  rankReason: string;
}

export type SourceReranker = (
  question: string,
  documents: readonly string[],
  context: ExecutionContext | undefined
) => Promise<RerankScore[]>;

export type SourceRerankOutcome =
  | { strategy: "rule"; reason: "disabled" }
  | { strategy: "rerank"; latencyMs: number }
  | { strategy: "rule"; reason: "fallback"; errorCode: string; latencyMs: number };

export function isSourceRerankEnabled(): boolean {
  return getBooleanEnv(SOURCE_RERANK_ENV, false);
}

export function sourceRerankDocument(candidate: Pick<RankCandidate, "title" | "snippet">): string {
  return `${candidate.title}\n${candidate.snippet}`.trim().slice(0, MAX_DOCUMENT_CHARS) || "(empty)";
}

let defaultReranker: SourceReranker | undefined;

function getDefaultReranker(): SourceReranker {
  defaultReranker ??= (() => {
    const config = readKnowledgeConfig();
    const gateway = new HttpKnowledgeModelGateway(config);
    const broker = createKnowledgeSecretBroker();
    return async (question, documents, context) => {
      const executionContext = context ?? createSystemExecutionContext("deep-research-source-rerank");
      const credential = (await broker.resolve(KNOWLEDGE_MODEL_SECRET, executionContext)).value;
      return gateway.rerank(question, documents, { credential, context: executionContext });
    };
  })();
  return defaultReranker;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * Reorders rule-ranked candidates by rerank score. Candidates the provider did not score keep
 * their relative rule order after the scored ones. Returns the input order on any failure.
 */
export async function rerankCandidates<TCandidate extends RankCandidate>(
  question: string,
  ruleRanked: readonly TCandidate[],
  options: {
    enabled?: boolean;
    reranker?: SourceReranker;
    context?: ExecutionContext;
    now?: () => number;
  } = {}
): Promise<{ ranked: TCandidate[]; outcome: SourceRerankOutcome }> {
  if (!(options.enabled ?? isSourceRerankEnabled()) || ruleRanked.length === 0) {
    return { ranked: [...ruleRanked], outcome: { strategy: "rule", reason: "disabled" } };
  }
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const reranker = options.reranker ?? getDefaultReranker();
    const scores = await reranker(question, ruleRanked.map(sourceRerankDocument), options.context);
    const byIndex = new Map<number, number>();
    for (const item of scores) {
      if (Number.isInteger(item.index) && item.index >= 0 && item.index < ruleRanked.length && Number.isFinite(item.score)) {
        byIndex.set(item.index, item.score);
      }
    }
    if (byIndex.size === 0) throw Object.assign(new Error("Rerank returned no usable scores"), { code: "RERANK_EMPTY" });
    const ranked = ruleRanked
      .map((candidate, index) => ({ candidate, index, rerank: byIndex.get(index) }))
      .sort((left, right) => {
        if (left.rerank !== undefined && right.rerank !== undefined) return right.rerank - left.rerank || left.index - right.index;
        if (left.rerank !== undefined) return -1;
        if (right.rerank !== undefined) return 1;
        return left.index - right.index;
      })
      .map(({ candidate, rerank }) =>
        rerank === undefined
          ? candidate
          : { ...candidate, rankReason: `rerank ${rerank.toFixed(3)}; rule ${candidate.score} (${candidate.rankReason})` }
      );
    const latencyMs = now() - startedAt;
    void recordMetric("deep_research.source_rerank", { outcome: "reranked", candidates: ruleRanked.length, latencyMs }, options.context);
    return { ranked, outcome: { strategy: "rerank", latencyMs } };
  } catch (error) {
    const latencyMs = now() - startedAt;
    const code = errorCode(error);
    void recordMetric("deep_research.source_rerank", { outcome: "fallback", errorCode: code, candidates: ruleRanked.length, latencyMs }, options.context);
    return { ranked: [...ruleRanked], outcome: { strategy: "rule", reason: "fallback", errorCode: code, latencyMs } };
  }
}
