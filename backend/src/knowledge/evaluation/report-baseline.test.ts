import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readManualInspection, renderComparisonMarkdown, type EvaluationProvenance } from "./report.js";
import { summarize, summarizeStrata, type CaseResult, type EvaluationRun } from "./runner.js";
const provenance: EvaluationProvenance = {
  datasetVersion: "kb-eval-v2", datasetSha256: "same", queryMode: "raw_question", corpusVersion: "kb-v1", split: "test",
  embeddingModel: "fake", embeddingSpaceId: "fake:2", rerankModel: "fake", generationModel: "fake", judgeModel: null,
  answerPromptVersion: "test", judgePromptVersion: null, thresholdVersion: "v1", configVersion: "v1", runCount: 1, date: "2026-11-02", synthetic: true,
};
function fixture(origin: "template" | "hand_authored", n: number, score: number, split: "dev" | "test" = "test", degraded = false): CaseResult[] {
  return Array.from({ length: n }, (_, index) => ({
    caseId: `${origin}-${split}-${index}`, split, origin, tags: ["sku_lookup", "same_series"],
    expectedKind: "answerable", status: "completed", retrievalMode: degraded ? "vector_only_degraded" : "vector_rerank",
    kbOutcome: "evidence_found", rankedSourceIds: ["p"], candidateScores: [], recallAt5: score, reciprocalRank: score, abstained: false, latencyMs: 50,
  }));
}
function run(results: CaseResult[], strategy: EvaluationRun["strategy"] = "vector_only"): EvaluationRun {
  return { strategy, datasetVersion: "kb-eval-v2", datasetSha256: "same", evaluationRunId: strategy, status: "completed", failedCases: [], results,
    summary: { dev: summarize(results.filter((item) => item.split === "dev")), test: summarize(results.filter((item) => item.split === "test")), all: summarize(results) },
  };
}
const render = (runs: EvaluationRun[], split: "dev" | "test" = "test") => renderComparisonMarkdown(runs, { ...provenance, split }, readManualInspection(undefined));
describe("baseline report", () => {
  it.each(["dev", "test"] as const)("keeps degradation in its own split and stratum (M3): %s", (degradedSplit) => {
    const cleanSplit = degradedSplit === "dev" ? "test" : "dev";
    const results = [...fixture("hand_authored", 5, 1, cleanSplit), ...fixture("template", 5, 1, degradedSplit, true)];
    expect(render([run(results)], cleanSplit)).not.toContain("degraded 5");
    expect(render([run(results)], degradedSplit)).toContain("degraded 5");
    const strata = summarizeStrata(results);
    expect(strata["origin:hand_authored"].degradedCases).toBe(0);
    expect(strata["origin:template"].degradedCases).toBe(5);
    expect(strata["tag:sku_lookup"].cases).toBe(10);
    expect(strata["tag:same_series"].cases).toBe(10);
  });
  it("does not claim template-only gains; exposes strata and sample sizes", () => {
    const markdown = render([run([...fixture("hand_authored", 5, 0.5), ...fixture("template", 5, 0)]), run([...fixture("hand_authored", 5, 0.5), ...fixture("template", 5, 1)], "vector_rerank")]);
    for (const text of ["no improvement", "diagnostic only", "Mixed aggregate", "not a basis for improvement", "overlap", "raw_question", "cross_lingual", "not online end-to-end"]) expect(markdown).toContain(text);
    expect(markdown.indexOf("Improvement")).toBeLessThan(markdown.indexOf("Origin strata"));
    expect(markdown.indexOf("Origin strata")).toBeLessThan(markdown.indexOf("Tag strata"));
    expect(markdown.indexOf("Mixed aggregate")).toBeLessThan(markdown.indexOf("Stage latency"));
  });
  it.each([
    [5, 0.5, 1, "improved"],
    [3, 0, 1, "insufficient sample"],
    [5, 0.5, 0.6, "within one-case resolution"],
  ])("judges human gains with n=%s", (n, before, after, expected) => {
    expect(render([run(fixture("hand_authored", n, before)), run(fixture("hand_authored", n, after), "vector_rerank")])).toContain(expected);
  });
  it("refuses comparison for missing/different hashes, versions or incomplete runs", () => {
    for (const patch of [{ datasetSha256: undefined }, { datasetSha256: "different" }, { datasetVersion: "kb-eval-v3" }, { status: "incomplete" as const }]) {
      const markdown = render([run(fixture("hand_authored", 5, 0)), { ...run(fixture("hand_authored", 5, 1), "vector_rerank"), ...patch }]);
      expect(markdown).toContain("comparison refused");
      expect(markdown).not.toContain(": improved");
    }
  });
  it("shows n/a for answerable metrics in abstain-only strata and unclassified legacy cases", () => {
    const results: CaseResult[] = [{ caseId: "abstain", status: "completed", split: "test", tags: ["near_miss"], expectedKind: "abstain", retrievalMode: "vector_only_configured", kbOutcome: "no_source_found", rankedSourceIds: [], candidateScores: [], abstained: true, latencyMs: 1 }];
    const markdown = render([run(results)]);
    expect(markdown).toContain("unclassified");
    expect(markdown).toContain("| vector_only / tag:near_miss | 0 | 1 | n/a | n/a |");
    expect(markdown).toContain("unmeasured");
  });
  it("loads the recorded v1 rerank result without inventing stage measurements", async () => {
    const old: EvaluationRun = JSON.parse(await readFile("data/knowledge-eval/results/kb-eval-v1-2026-10-27-r2/run-vector_rerank.json", "utf8"));
    expect(render([old])).toContain("unmeasured");
    expect(summarize(old.results).recallAt5).toBe(old.summary.all.recallAt5);
    expect(summarize(old.results).stageLatency?.rerank.p50Ms).toBeNull();
  });
});
