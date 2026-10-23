import { randomUUID } from "node:crypto";

import type { KnowledgeConfig } from "../config.js";
import { createSystemExecutionContext } from "../connection.js";
import { isKnowledgeError } from "../errors.js";
import type { KnowledgeModelGateway } from "../model-gateway.js";
import { buildSearchResult, retrieveCandidates } from "../retrieval.js";
import type { KnowledgeStore } from "../store.js";
import type { EvalCase } from "./eval-case.js";
import { citationAccuracy, mean, percentile, rankedSources, recallAtK, reciprocalRank, type CitationJudgement } from "./scorers.js";
import type { AnswerSynthesizer, FaithfulnessJudge } from "./synthesis.js";

export type EvaluationStrategy = "vector_only" | "vector_rerank";

export interface CandidateScore {
  sourceId: string;
  similarity: number;
  rerankScore?: number;
}

/** Evidence shown to the synthesizer; stored so manual review can check claims against it. */
export interface EvidenceBlock {
  citationId: string;
  sourceId: string;
  title: string;
  content: string;
}

export type CaseResult =
  | {
      caseId: string;
      split: "dev" | "test";
      expectedKind: "answerable" | "abstain";
      status: "completed";
      /** Correlates this case with its model-usage events and traces. */
      requestId?: string;
      question?: string;
      retrievalMode: string;
      degradationReason?: string;
      kbOutcome: "evidence_found" | "no_source_found";
      evidence?: EvidenceBlock[];
      /** Ranked sources before the evidence threshold; Recall@5 and MRR measure the ranker. */
      rankedSourceIds: string[];
      candidateScores: CandidateScore[];
      recallAt5?: number;
      reciprocalRank?: number;
      abstained: boolean;
      answer?: string;
      citationAccuracy?: number;
      citationJudgements?: CitationJudgement[];
      faithfulness?: number;
      unsupportedClaims?: string[];
      judgeSupportedClaims?: number;
      judgeTotalClaims?: number;
      latencyMs: number;
    }
  | {
      caseId: string;
      split: "dev" | "test";
      expectedKind: "answerable" | "abstain";
      status: "failed";
      requestId?: string;
      errorCode: string;
      latencyMs: number;
    };

export interface EvaluationRunInput {
  cases: readonly EvalCase[];
  strategy: EvaluationStrategy;
  tenantId: string;
  store: KnowledgeStore;
  gateway: KnowledgeModelGateway;
  credential: string;
  config: KnowledgeConfig;
  synthesizer: AnswerSynthesizer;
  judge?: FaithfulnessJudge;
  signal?: AbortSignal;
  now?: () => number;
  /** Shared runId for every case in this evaluation run. */
  evaluationRunId?: string;
}

const CANDIDATE_SCORE_LIMIT = 10;

export async function evaluateCase(input: EvaluationRunInput, item: EvalCase): Promise<CaseResult> {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const requestId = `kb-eval-req-${randomUUID()}`;
  const context = createSystemExecutionContext("kb-evaluation", {
    ...(input.evaluationRunId ? { runId: input.evaluationRunId } : {}),
    requestId,
    taskId: item.caseId,
  });
  const base = { caseId: item.caseId, split: item.split, expectedKind: item.expected.kind, requestId };
  try {
    const retrieved = await retrieveCandidates({
      query: item.input.question,
      tenantId: input.tenantId,
      strategy: input.strategy === "vector_only" ? "vector_only" : "auto",
      store: input.store,
      gateway: input.gateway,
      credential: input.credential,
      config: input.config,
      context,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const result = buildSearchResult(retrieved, input.config);
    const rankedSourceIds = rankedSources(retrieved.candidates.map((candidate) => candidate.chunk.sourceId));
    const candidateScores = retrieved.candidates.slice(0, CANDIDATE_SCORE_LIMIT).map((candidate) => ({
      sourceId: candidate.chunk.sourceId,
      similarity: candidate.chunk.similarity,
      ...(candidate.rerankScore !== undefined ? { rerankScore: candidate.rerankScore } : {}),
    }));
    const relevant = item.expected.kind === "answerable" ? item.expected.relevantSourceIds : [];

    let abstained = result.outcome === "no_source_found";
    let answer: string | undefined;
    let accuracy: ReturnType<typeof citationAccuracy> | undefined;
    let faithfulness: { score: number; unsupportedClaims: string[]; supportedClaims?: number; totalClaims?: number } | undefined;
    if (result.outcome === "evidence_found") {
      const synthesized = await input.synthesizer.synthesize(item.input.question, result, input.signal);
      abstained = synthesized.abstained;
      answer = synthesized.answer;
      const evidence = new Map(result.citations.map((citation) => [citation.citationId, citation.sourceId]));
      if (!abstained) {
        accuracy = citationAccuracy(synthesized.citations, evidence, relevant);
        if (input.judge) faithfulness = await input.judge.judge(item.input.question, synthesized.answer, result, input.signal);
      }
    }

    const evidence =
      result.outcome === "evidence_found"
        ? result.chunks.map((chunk) => {
            const citation = result.citations.find((item) => item.citationId === chunk.citationId);
            return { citationId: chunk.citationId, sourceId: citation?.sourceId ?? "", title: citation?.title ?? "", content: chunk.content };
          })
        : undefined;
    return {
      ...base,
      status: "completed",
      question: item.input.question,
      retrievalMode: retrieved.mode,
      ...(retrieved.degradation ? { degradationReason: retrieved.degradation.reason } : {}),
      kbOutcome: result.outcome,
      ...(evidence ? { evidence } : {}),
      rankedSourceIds: rankedSourceIds.slice(0, CANDIDATE_SCORE_LIMIT),
      candidateScores,
      ...(item.expected.kind === "answerable"
        ? { recallAt5: recallAtK(rankedSourceIds, relevant, 5), reciprocalRank: reciprocalRank(rankedSourceIds, relevant) }
        : {}),
      abstained,
      ...(answer !== undefined ? { answer } : {}),
      ...(item.expected.kind === "answerable" && !abstained
        ? { citationAccuracy: accuracy?.value ?? 0, citationJudgements: accuracy?.judgements ?? [] }
        : {}),
      ...(faithfulness ? { faithfulness: faithfulness.score, unsupportedClaims: faithfulness.unsupportedClaims } : {}),
      ...(faithfulness?.totalClaims !== undefined ? { judgeSupportedClaims: faithfulness.supportedClaims ?? 0, judgeTotalClaims: faithfulness.totalClaims } : {}),
      latencyMs: now() - startedAt,
    };
  } catch (error) {
    const errorCode = isKnowledgeError(error)
      ? error.code
      : error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "EVAL_CASE_FAILED";
    return { ...base, status: "failed", errorCode, latencyMs: now() - startedAt };
  }
}

export interface SplitSummary {
  cases: number;
  answerableCases: number;
  abstainCases: number;
  recallAt5: number | null;
  mrr: number | null;
  citationAccuracy: number | null;
  faithfulness: number | null;
  abstentionAccuracy: number | null;
  falseAbstentionRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface EvaluationRun {
  strategy: EvaluationStrategy;
  evaluationRunId: string;
  /** Incomplete runs are reported but never published as scores. */
  status: "completed" | "incomplete";
  failedCases: string[];
  results: CaseResult[];
  summary: Record<"dev" | "test" | "all", SplitSummary>;
}

export function summarize(results: readonly CaseResult[]): SplitSummary {
  const completed = results.filter((result): result is Extract<CaseResult, { status: "completed" }> => result.status === "completed");
  const answerable = completed.filter((result) => result.expectedKind === "answerable");
  const abstain = completed.filter((result) => result.expectedKind === "abstain");
  const answered = answerable.filter((result) => !result.abstained);
  return {
    cases: results.length,
    answerableCases: answerable.length,
    abstainCases: abstain.length,
    recallAt5: mean(answerable.map((result) => result.recallAt5 ?? 0)),
    mrr: mean(answerable.map((result) => result.reciprocalRank ?? 0)),
    citationAccuracy: mean(answered.map((result) => result.citationAccuracy ?? 0)),
    faithfulness: mean(answered.flatMap((result) => (result.faithfulness === undefined ? [] : [result.faithfulness]))),
    abstentionAccuracy: mean(abstain.map((result) => (result.abstained ? 1 : 0))),
    falseAbstentionRate: mean(answerable.map((result) => (result.abstained ? 1 : 0))),
    latencyP50Ms: percentile(completed.map((result) => result.latencyMs), 0.5),
    latencyP95Ms: percentile(completed.map((result) => result.latencyMs), 0.95),
  };
}

export async function runEvaluation(rawInput: EvaluationRunInput): Promise<EvaluationRun> {
  const evaluationRunId = rawInput.evaluationRunId ?? `kb-eval-run-${randomUUID()}`;
  const input = { ...rawInput, evaluationRunId };
  const results: CaseResult[] = [];
  for (const item of input.cases) {
    if (input.signal?.aborted) {
      results.push({ caseId: item.caseId, split: item.split, expectedKind: item.expected.kind, status: "failed", errorCode: "KB_CANCELLED", latencyMs: 0 });
      continue;
    }
    results.push(await evaluateCase(input, item));
  }
  const failedCases = results.filter((result) => result.status === "failed").map((result) => result.caseId);
  return {
    strategy: input.strategy,
    evaluationRunId,
    status: failedCases.length === 0 ? "completed" : "incomplete",
    failedCases,
    results,
    summary: {
      dev: summarize(results.filter((result) => result.split === "dev")),
      test: summarize(results.filter((result) => result.split === "test")),
      all: summarize(results),
    },
  };
}
