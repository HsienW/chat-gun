import { describe, expect, it } from "vitest";

import {
  chainResultDirectoryName,
  isChainRunPublishable,
  renderChainReportMarkdown,
  type ChainEvaluationProvenance,
} from "./chain-report.js";
import { summarizeChainRun, type ChainCaseResult, type ChainEvaluationRun } from "./chain-scoring.js";

const provenance: ChainEvaluationProvenance = {
  datasetVersion: "chain-eval-v1",
  corpusVersion: "kb-v1",
  orderFixtureVersion: "synthetic-orders-v1",
  split: "all",
  mode: "deterministic",
  graphId: "shopping_assistant",
  intentPromptVersion: "scripted:chain-eval-v1",
  policyPromptVersion: "scripted:chain-eval-v1",
  embeddingModel: null,
  embeddingSpaceId: null,
  rerankModel: null,
  generationModel: null,
  judgeModel: null,
  thresholdVersion: null,
  configVersion: "chain-eval-scripted-retrieval-v1",
  confirmationTimeoutMs: { default: 900_000, expireCases: 1_000 },
  runCount: 1,
  date: "2026-10-27",
  synthetic: true,
};

function run(results: ChainCaseResult[]): ChainEvaluationRun {
  const failedCases = results.filter((result) => result.status === "failed").map((result) => result.caseId);
  return {
    mode: "deterministic",
    evaluationRunId: "chain-eval-run-1",
    datasetVersion: "chain-eval-v1",
    status: failedCases.length === 0 ? "completed" : "incomplete",
    failedCases,
    results,
    summary: summarizeChainRun(results, "deterministic"),
  };
}

const completedCase: ChainCaseResult = {
  caseId: "chain-eval-v1-policy-01",
  split: "dev",
  status: "completed",
  passed: false,
  latencyMs: 4,
  observations: [],
  turns: [
    {
      turnIndex: 0,
      route: { expected: "policy_question", actual: "policy_question", routeStatus: "routed", correct: true },
      answer: { expectedKind: "answerable", answerStatus: "unverified", correct: false, falseAbstention: false },
      prohibitedOutcomes: [],
      passed: false,
    },
  ],
};

describe("chain evaluation report", () => {
  it("names the result directory by dataset, mode and date", () => {
    expect(chainResultDirectoryName("chain-eval-v1", "deterministic", "2026-10-27")).toBe("chain-eval-v1-deterministic-2026-10-27");
  });

  it("publishes a completed run and states routing as not measured with the synthetic-data notice", () => {
    const report = renderChainReportMarkdown(run([completedCase]), provenance);

    expect(isChainRunPublishable(run([completedCase]))).toBe(true);
    expect(report).toContain("deterministic");
    expect(report).toContain("not_measured");
    expect(report).toContain("合成資料");
    expect(report).toContain("chain-eval-v1-policy-01");
    expect(report).toContain("unverified");
    expect(report).not.toContain("不可發布");
  });

  it("marks an incomplete run as not publishable and names the case that did not finish", () => {
    const failed: ChainCaseResult = { caseId: "chain-eval-v1-x", split: "test", status: "failed", errorCode: "CHAIN_CASE_TIMEOUT", latencyMs: 1 };

    const report = renderChainReportMarkdown(run([completedCase, failed]), provenance);

    expect(isChainRunPublishable(run([completedCase, failed]))).toBe(false);
    expect(report).toContain("不可發布");
    expect(report).toContain("chain-eval-v1-x");
    expect(report).toContain("CHAIN_CASE_TIMEOUT");
  });
});
