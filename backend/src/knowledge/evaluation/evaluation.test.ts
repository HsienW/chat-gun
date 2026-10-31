import { describe, expect, it } from "vitest";

import { prepareCorpus } from "../corpus.js";
import { KnowledgeError } from "../errors.js";
import { InMemoryKnowledgeStore } from "../in-memory-store.js";
import { ingestCorpus } from "../ingestion.js";
import type { KbSearchResult } from "../retrieval.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "../testing-fakes.js";
import { parseEvalDataset, type EvalCase } from "./eval-case.js";
import { caseScores } from "./opik-publisher.js";
import { isPublishable, manualInspectionTemplate, readManualInspection, renderComparisonMarkdown, type EvaluationProvenance } from "./report.js";
import { runEvaluation, type EvaluationRunInput } from "./runner.js";
import { citationAccuracy, percentile, recallAtK, reciprocalRank } from "./scorers.js";
import type { AnswerSynthesizer, FaithfulnessJudge } from "./synthesis.js";

describe("retrieval scorers", () => {
  it("computes Recall@K over unique ranked sources", () => {
    expect(recallAtK(["a", "a", "b", "c"], ["b", "z"], 5)).toBe(0.5);
    expect(recallAtK(["x1", "x2", "x3", "x4", "x5", "b"], ["b"], 5)).toBe(0);
  });

  it("computes reciprocal rank of the first relevant source", () => {
    expect(reciprocalRank(["a", "a", "b"], ["b"])).toBe(0.5);
    expect(reciprocalRank(["a"], ["b"])).toBe(0);
  });

  it("scores citations by resolvability and relevance, and zero without citations", () => {
    const evidence = new Map([["c1", "policy-a"], ["c2", "policy-b"]]);
    expect(citationAccuracy(["c1", "c2", "c9"], evidence, ["policy-a"]).value).toBeCloseTo(1 / 3);
    expect(citationAccuracy([], evidence, ["policy-a"]).value).toBe(0);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([], 0.5)).toBeNull();
  });
});

const config = testKnowledgeConfig();

const SOURCES: Record<string, string> = {
  "policy-return-window": "Most items can be returned within 30 days of the delivery date.",
  "policy-shipping-fees": "Standard shipping is free for orders of 50 USD or more.",
};

function evalCase(caseId: string, question: string, expected: EvalCase["expected"], split: "dev" | "test" = "test"): EvalCase {
  return parseEvalDataset({
    datasetVersion: "kb-eval-test",
    corpusVersion: "kb-test",
    synthetic: true,
    createdAt: "2026-10-23",
    cases: [{
      schemaVersion: "eval_case@1", caseId, datasetVersion: "kb-eval-test", split,
      input: { question, language: "en" }, expected, prohibitedOutcomes: [], scoring: { scorers: ["recall_at_5"] },
      provenance: { synthetic: true, createdAt: "2026-10-23", method: "test" }, sensitivityClass: "internal-synthetic", tags: [],
    }],
  }).cases[0];
}

class EchoSynthesizer implements AnswerSynthesizer {
  readonly model = "fake-generator";
  readonly promptVersion = "kb-answer-test";
  async synthesize(_question: string, evidence: Extract<KbSearchResult, { outcome: "evidence_found" }>) {
    return { abstained: false, answer: `${evidence.chunks[0].content} [c1]`, citations: ["c1"] };
  }
}

class FixedJudge implements FaithfulnessJudge {
  readonly model = "fake-judge";
  readonly promptVersion = "kb-faithfulness-test";
  async judge() {
    return { score: 1, unsupportedClaims: [] };
  }
}

async function evaluationInput(overrides: Partial<EvaluationRunInput> = {}): Promise<EvaluationRunInput> {
  const store = new InMemoryKnowledgeStore();
  await ingestCorpus({
    runId: "seed",
    tenantId: "public",
    corpus: prepareCorpus({
      products: [],
      policyMarkdown: Object.entries(SOURCES).map(([sourceId, body]) => ({
        origin: sourceId,
        markdown: `---\nsynthetic: true\ncorpusVersion: kb-test\ngeneratedAt: 2026-10-23\nsourceId: ${sourceId}\nsourceType: policy\ntitle: ${sourceId}\n---\n\n${body}`,
      })),
    }),
    store,
    gateway: new FakeKnowledgeModelGateway({ dimensions: 64 }),
    credential: "test-credential",
    config,
  });
  return {
    cases: [
      evalCase("case-return", "How many days can items be returned after the delivery date?", { kind: "answerable", relevantSourceIds: ["policy-return-window"], keyFacts: ["30 days"] }),
      evalCase("case-abstain", "Which telescope lens fits a lunar observatory dome?", { kind: "abstain" }),
    ],
    strategy: "vector_rerank",
    tenantId: "public",
    store,
    gateway: new FakeKnowledgeModelGateway({ dimensions: 64 }),
    credential: "test-credential",
    config,
    synthesizer: new EchoSynthesizer(),
    judge: new FixedJudge(),
    ...overrides,
  };
}

const PROVENANCE: EvaluationProvenance = {
  datasetVersion: "kb-eval-test", corpusVersion: "kb-test", split: "test", embeddingModel: "text-embedding-v4",
  embeddingSpaceId: "text-embedding-v4:64", rerankModel: "qwen3-rerank", generationModel: "fake-generator", judgeModel: "fake-judge",
  answerPromptVersion: "kb-answer-test", judgePromptVersion: "kb-faithfulness-test", thresholdVersion: "kb-threshold-v0",
  configVersion: "kb-config-v1", runCount: 1, date: "2026-10-23", synthetic: true,
};

describe("retrieval evaluation runner", () => {
  it("scores answerable and abstain cases end to end", async () => {
    const run = await runEvaluation(await evaluationInput());
    expect(run.status).toBe("completed");
    const [answerable, abstain] = run.results;
    expect(answerable).toMatchObject({ status: "completed", kbOutcome: "evidence_found", recallAt5: 1, reciprocalRank: 1, citationAccuracy: 1, faithfulness: 1, abstained: false });
    expect(abstain).toMatchObject({ status: "completed", kbOutcome: "no_source_found", abstained: true });
    expect(run.summary.test).toMatchObject({ recallAt5: 1, mrr: 1, citationAccuracy: 1, abstentionAccuracy: 1, falseAbstentionRate: 0 });
  });

  it("correlates each case with a requestId under one evaluation runId, down to the model gateway", async () => {
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    const run = await runEvaluation(await evaluationInput({ gateway, evaluationRunId: "kb-eval-run-test" }));
    expect(run.evaluationRunId).toBe("kb-eval-run-test");
    const requestIds = run.results.map((result) => result.requestId);
    expect(new Set(requestIds).size).toBe(run.results.length);
    expect(gateway.contexts.map((context) => context?.runId)).toEqual(run.results.map(() => "kb-eval-run-test"));
    expect(gateway.contexts.map((context) => context?.requestId)).toEqual(requestIds);
  });

  it("keeps the judge's raw claim counts next to the score", async () => {
    const judge: FaithfulnessJudge = {
      model: "fake-judge",
      promptVersion: "kb-faithfulness-test",
      judge: async () => ({ score: 0.5, unsupportedClaims: ["claim b"], supportedClaims: 1, totalClaims: 2 }),
    };
    const run = await runEvaluation(await evaluationInput({ judge }));
    expect(run.results[0]).toMatchObject({ faithfulness: 0.5, judgeSupportedClaims: 1, judgeTotalClaims: 2, unsupportedClaims: ["claim b"] });
  });

  it("keeps the egress classification and reason when rerank degrades at egress", async () => {
    const gateway = new FakeKnowledgeModelGateway({
      dimensions: 64,
      failRerank: new KnowledgeError("EGRESS_POLICY_UNAVAILABLE", "egress failed", "DNS_RESOLUTION_FAILED"),
    });
    const run = await runEvaluation(await evaluationInput({ gateway }));
    const degraded = run.results.find((result) => result.status === "completed" && result.retrievalMode === "vector_only_degraded");

    expect(degraded).toMatchObject({
      degradationReason: "RERANK_PROVIDER_ERROR",
      degradationEgressErrorCode: "EGRESS_POLICY_UNAVAILABLE",
      degradationEgressReasonCode: "DNS_RESOLUTION_FAILED",
    });
  });

  it("keeps raw candidate scores so thresholds can be calibrated on the dev split", async () => {
    const run = await runEvaluation(await evaluationInput({ strategy: "vector_only" }));
    const first = run.results[0];
    expect(first.status === "completed" && first.retrievalMode).toBe("vector_only_configured");
    expect(first.status === "completed" && first.candidateScores[0]).toMatchObject({ sourceId: "policy-return-window" });
  });

  it("marks the run incomplete and unpublishable when any case fails", async () => {
    const failing: AnswerSynthesizer = {
      model: "fake",
      promptVersion: "x",
      synthesize: async () => {
        throw Object.assign(new Error("bad output"), { code: "EVAL_MODEL_OUTPUT_INVALID" });
      },
    };
    const run = await runEvaluation(await evaluationInput({ synthesizer: failing }));
    expect(run.status).toBe("incomplete");
    expect(run.failedCases).toEqual(["case-return"]);
    expect(run.results[0]).toMatchObject({ status: "failed", errorCode: "EVAL_MODEL_OUTPUT_INVALID" });
    expect(isPublishable([run])).toBe(false);
    const markdown = renderComparisonMarkdown([run], PROVENANCE, readManualInspection(undefined));
    expect(markdown).toContain("Not publishable");
  });

  it("reports cancellation as failed cases instead of a partial score", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runEvaluation(await evaluationInput({ signal: controller.signal }));
    expect(run.status).toBe("incomplete");
    expect(run.results.every((result) => result.status === "failed" && result.errorCode === "KB_CANCELLED")).toBe(true);
  });
});

describe("evaluation report", () => {
  it("records full provenance and holds faithfulness until manual inspection is complete", async () => {
    const run = await runEvaluation(await evaluationInput());
    const pending = renderComparisonMarkdown([run], PROVENANCE, readManualInspection(undefined));
    expect(pending).toContain("pending manual inspection");
    for (const field of ["kb-eval-test", "synthetic", "text-embedding-v4", "qwen3-rerank", "kb-answer-test", "kb-threshold-v0", "runs 1", "2026-10-23"]) {
      expect(pending).toContain(field);
    }
    const inspection = readManualInspection({
      inspector: "Master",
      inspectedAt: "2026-10-23",
      items: Array.from({ length: 10 }, (_, index) => ({ caseId: `c${index}`, strategy: "vector_rerank", judgeScore: 1, humanAgrees: index !== 0 })),
    });
    expect(inspection).toEqual({ complete: true, inspected: 10, agreementRate: 0.9 });
    expect(renderComparisonMarkdown([run], PROVENANCE, inspection)).not.toContain("pending manual inspection");
  });

  it("samples judged cases deterministically for manual review", async () => {
    const run = await runEvaluation(await evaluationInput());
    const first = manualInspectionTemplate([run]);
    expect(first.items.map((item) => item.caseId)).toEqual(manualInspectionTemplate([run]).items.map((item) => item.caseId));
    expect(first.items.every((item) => item.humanAgrees === null)).toBe(true);
  });

  it("gives each review item the question and the exact evidence the answer used", async () => {
    const run = await runEvaluation(await evaluationInput());
    const [item] = manualInspectionTemplate([run]).items;
    expect(item.question).toBe("How many days can items be returned after the delivery date?");
    expect(item.evidenceSource).toBe("recorded");
    expect(item.evidence[0]).toMatchObject({ citationId: "c1", sourceId: "policy-return-window" });
    expect(item.answer).toContain("[c1]");
  });

  it("always includes judged cases below a full score and spreads the rest across strategies", async () => {
    const run = await runEvaluation(await evaluationInput());
    const completed = run.results[0];
    if (completed.status !== "completed") throw new Error("expected a completed case");
    const synthetic = (strategy: "vector_only" | "vector_rerank", scores: number[]) => ({
      ...run,
      strategy,
      results: scores.map((score, index) => ({ ...completed, caseId: `${strategy}-${index}`, faithfulness: score })),
    });
    const template = manualInspectionTemplate([synthetic("vector_only", [1, 1, 1, 1, 1, 1, 0.5]), synthetic("vector_rerank", [1, 1, 1, 1, 1, 1, 0.75])], { sampleSize: 6 });
    expect(template.items).toHaveLength(6);
    expect(template.items.slice(0, 2).map((item) => item.judgeScore)).toEqual([0.5, 0.75]);
    const fullScore = template.items.slice(2);
    expect(new Set(fullScore.map((item) => item.strategy))).toEqual(new Set(["vector_only", "vector_rerank"]));
  });

  it("exposes only applicable scores to Opik", async () => {
    const run = await runEvaluation(await evaluationInput());
    expect(caseScores(run.results[0])).toMatchObject({ recall_at_5: 1, mrr: 1, citation_accuracy: 1 });
    expect(caseScores(run.results[0])).not.toHaveProperty("abstention_correct");
    expect(caseScores(run.results[1])).toMatchObject({ abstention_correct: 1 });
    expect(caseScores(run.results[1])).not.toHaveProperty("recall_at_5");
  });
});
