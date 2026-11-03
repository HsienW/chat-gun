import { KnowledgeError } from "../errors.js";
import type { KnowledgeModelGateway } from "../model-gateway.js";
import type { KnowledgeStore, RecallQuery } from "../store.js";
import type { AnswerSynthesizer, FaithfulnessJudge } from "./synthesis.js";
import { percentile } from "./scorers.js";

export const EVALUATION_STAGES = ["embedding", "recall", "rerank", "generation", "judge"] as const;
export type EvaluationStage = (typeof EVALUATION_STAGES)[number];
export type StageTiming = { status: "completed" | "failed"; ms: number } | { status: "not_run" };
export type StageLatency = Record<EvaluationStage, StageTiming>;
export interface StageSummary { completed: number; failed: number; notRun: number; unmeasured: number; p50Ms: number | null; p95Ms: number | null }
export type StageLatencySummary = Record<EvaluationStage, StageSummary>;
export function createStageLatency(): StageLatency {
  return { embedding: { status: "not_run" }, recall: { status: "not_run" }, rerank: { status: "not_run" }, generation: { status: "not_run" }, judge: { status: "not_run" } };
}
export function instrumentEvaluation(input: { gateway: KnowledgeModelGateway; store: KnowledgeStore; synthesizer: AnswerSynthesizer; judge?: FaithfulnessJudge; signal?: AbortSignal }, now: () => number) {
  const stageLatency = createStageLatency();
  const measure = async <T>(stage: EvaluationStage, operation: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      if (input.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
      const result = await operation();
      if (input.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
      stageLatency[stage] = { status: "completed", ms: now() - startedAt };
      return result;
    } catch (error) {
      stageLatency[stage] = { status: "failed", ms: now() - startedAt };
      throw error;
    }
  };
  const gateway: KnowledgeModelGateway = {
    capabilities: input.gateway.capabilities,
    embed: (texts, options) => measure("embedding", () => input.gateway.embed(texts, options)),
    rerank: (query, documents, options) => measure("rerank", () => input.gateway.rerank(query, documents, options)),
  };
  // Bind untouched store methods to the original instance, including native private-field receivers.
  const store = new Proxy(input.store, {
    get(target, key, receiver) {
      if (key === "recall") return (query: RecallQuery) => measure("recall", () => target.recall(query));
      const member: unknown = Reflect.get(target, key, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const synthesizer: AnswerSynthesizer = {
    model: input.synthesizer.model, promptVersion: input.synthesizer.promptVersion,
    synthesize: (...args) => measure("generation", () => input.synthesizer.synthesize(...args)),
  };
  const judge: FaithfulnessJudge | undefined = input.judge ? {
    model: input.judge.model, promptVersion: input.judge.promptVersion,
    judge: (...args) => measure("judge", () => input.judge!.judge(...args)),
  } : undefined;
  return { stageLatency, gateway, store, synthesizer, judge };
}
export function summarizeStages(results: readonly { stageLatency?: StageLatency }[]): StageLatencySummary {
  const summary = {} as StageLatencySummary;
  for (const stage of EVALUATION_STAGES) {
    const timings = results.flatMap((result) => result.stageLatency ? [result.stageLatency[stage]] : []);
    const completed = timings.flatMap((timing) => timing.status === "completed" ? [timing.ms] : []);
    summary[stage] = {
      completed: completed.length, failed: timings.filter((timing) => timing.status === "failed").length,
      notRun: timings.filter((timing) => timing.status === "not_run").length,
      unmeasured: results.length - timings.length, p50Ms: percentile(completed, 0.5), p95Ms: percentile(completed, 0.95),
    };
  }
  return summary;
}
/** Incomplete embedding/recall do not supply a retrieval measurement (M2). Failed rerank wait does. */
export function retrievalLatency(timing: StageLatency | undefined): number[] {
  if (!timing || timing.embedding.status !== "completed" || timing.recall.status !== "completed") return [];
  return [timing.embedding.ms + timing.recall.ms + (timing.rerank.status === "not_run" ? 0 : timing.rerank.ms)];
}
