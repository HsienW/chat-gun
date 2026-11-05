import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadResearchDataset, parseResearchDataset, type LoadedResearchDataset } from "./dataset.js";
import { renderReport } from "./report.js";
import { runResearchEvaluation, type AgentTrace } from "./runner.js";
import {
  extractCitationMarkers,
  extractUrls,
  nearestRankPercentile,
  scoreCase,
  scoreCitations,
  statesLimitation,
  type ObservedSource,
} from "./scoring.js";

const SOURCES: ObservedSource[] = [
  { index: 1, url: "https://example.com/a", usable: true },
  { index: 2, url: "https://example.org/b/", usable: true },
  { index: 3, url: "https://example.net/c", usable: false, fetchError: "Error: 404" },
];

function dataset(): LoadedResearchDataset {
  return parseResearchDataset({
    datasetVersion: "research-eval-v1",
    description: "fixture",
    createdAt: "2026-11-05",
    categories: { answerable: "a", no_source: "n", clarify: "c" },
    cases: [
      { caseId: "ans-01", category: "answerable", language: "en", question: "What is RRF in retrieval?" },
      { caseId: "nos-01", category: "no_source", stub: "empty_search", language: "en", question: "Latest FOMC statement?" },
      { caseId: "clr-01", category: "clarify", language: "en", question: "Compare them for me." },
    ],
  });
}

describe("research-eval dataset", () => {
  it("validates the committed v1 dataset", async () => {
    const loaded = await loadResearchDataset(join(import.meta.dirname, "..", "..", "..", "data", "research-eval", "research-eval-v1.json"));
    const count = (category: string) => loaded.dataset.cases.filter((item) => item.category === category).length;
    expect(loaded.dataset.cases).toHaveLength(26);
    expect(count("answerable")).toBe(16);
    expect(count("no_source")).toBe(6);
    expect(count("clarify")).toBe(4);
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a no_source case without a stub and duplicate ids", () => {
    const base = { datasetVersion: "research-eval-v1", description: "x", createdAt: "2026-11-05", categories: {} };
    expect(() => parseResearchDataset({ ...base, cases: [{ caseId: "nos-01", category: "no_source", language: "en", question: "Latest CPI?" }] })).toThrow(/RESEARCH_EVAL_DATASET_INVALID/u);
    const item = { caseId: "ans-01", category: "answerable", language: "en", question: "What is BM25?" };
    expect(() => parseResearchDataset({ ...base, cases: [item, item] })).toThrow(/unique/u);
  });

  it("hashes canonical content, not key order", () => {
    const first = dataset();
    const reordered = parseResearchDataset(JSON.parse(JSON.stringify({ ...first.dataset, description: first.dataset.description })));
    expect(reordered.sha256).toBe(first.sha256);
  });
});

describe("citation scoring", () => {
  it("parses bracket markers, lists and ranges but ignores years", () => {
    expect(extractCitationMarkers("A [1][2], B [1, 3], C [4-6], 2026 [2026]")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(extractCitationMarkers("依據來源 [2]、[3]，以及 [1，2]")).toEqual([1, 2, 3]);
  });

  it("normalizes URLs from prose and markdown links", () => {
    expect(extractUrls("See (https://Example.org/b/). Also [x](https://example.com/a#top)")).toEqual([
      "https://example.org/b",
      "https://example.com/a",
    ]);
  });

  it("passes only when every citation resolves to a usable source", () => {
    expect(scoreCitations("Fact [1]. Other fact [2] https://example.org/b", SOURCES)).toMatchObject({ pass: true, citedCount: 3, usableCitedCount: 3 });
    expect(scoreCitations("Fact [1] and [3]", SOURCES)).toMatchObject({ pass: false, unresolved: ["[3]"] });
    expect(scoreCitations("Fact [9]", SOURCES)).toMatchObject({ pass: false, unresolved: ["[9]"] });
    expect(scoreCitations("See https://unknown.example/x", SOURCES).pass).toBe(false);
    expect(scoreCitations("No citations here.", SOURCES).pass).toBeNull();
  });
});

describe("refusal and clarify scoring", () => {
  it("detects limitation statements in English and Chinese", () => {
    expect(statesLimitation("No usable sources were retrieved, so I cannot confirm the figure.")).toBe(true);
    expect(statesLimitation("The web search returned no results for this query.")).toBe(true);
    expect(statesLimitation("目前搜尋結果為空，無法提供最新數據。")).toBe(true);
    expect(statesLimitation("由于抓取失败，未能获取国家统计局的数据。")).toBe(true);
    expect(statesLimitation("The federal funds rate target range is 4.25% to 4.50%.")).toBe(false);
  });

  const observation = {
    caseId: "nos-01",
    category: "no_source" as const,
    stub: "empty_search" as const,
    status: "completed" as const,
    latencyMs: 10,
    queries: [],
    searchResultCount: 0,
    rankedUrls: [],
  };

  it("fails a refusal that still cites a source", () => {
    const failed = [{ index: 1, url: "https://example.com/a", usable: false }];
    expect(scoreCase({ ...observation, sources: failed, answer: "No usable sources were found [1]." }).refusal).toMatchObject({ pass: false, citedEvidence: true });
    expect(scoreCase({ ...observation, sources: failed, answer: "No usable sources were found." }).refusal?.pass).toBe(true);
    expect(scoreCase({ ...observation, sources: failed, answer: "無法取得資料，請查閱 https://www.cbc.gov.tw" }).refusal).toMatchObject({
      pass: true,
      urlsMentioned: ["https://www.cbc.gov.tw"],
    });
  });

  it("fails a refusal when the stub did not remove every usable source", () => {
    const usable = [{ index: 1, url: "https://example.com/a", usable: true }];
    expect(scoreCase({ ...observation, sources: usable, answer: "I could not find sources." }).refusal).toMatchObject({ pass: false, usableSourceCount: 1 });
  });

  it("scores clarify by planner route", () => {
    const base = { ...observation, caseId: "clr-01", category: "clarify" as const, stub: undefined, sources: [], answer: "Which fund?" };
    expect(scoreCase({ ...base, answerMode: "clarify" }).clarifyPass).toBe(true);
    expect(scoreCase({ ...base, answerMode: "direct" }).clarifyPass).toBe(false);
  });
});

describe("latency percentiles", () => {
  it("uses nearest rank", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(nearestRankPercentile(values, 50)).toBe(50);
    expect(nearestRankPercentile(values, 90)).toBe(90);
    expect(nearestRankPercentile([7], 90)).toBe(7);
    expect(nearestRankPercentile([], 50)).toBeNull();
  });
});

describe("research-eval runner", () => {
  it("runs cases sequentially, records failures and summarizes every metric", async () => {
    let clock = 0;
    const traces: Record<string, AgentTrace> = {
      "ans-01": { answerMode: "research", queries: ["rrf"], searchResultCount: 8, rankedUrls: ["https://example.com/a"], sources: SOURCES, answer: "RRF fuses ranks [1][2]." },
      "clr-01": { answerMode: "clarify", queries: [], searchResultCount: 0, rankedUrls: [], sources: [], answer: "Which items?" },
    };
    const run = await runResearchEvaluation(
      dataset(),
      async (item) => {
        clock += item.caseId === "ans-01" ? 3_000 : 1_000;
        if (!traces[item.caseId]) throw new Error("planner exploded");
        return traces[item.caseId];
      },
      { ranking: "rule", now: () => clock }
    );

    expect(run.observations.map((observation) => observation.status)).toEqual(["completed", "failed", "completed"]);
    expect(run.summary.citation.answerPassRate).toEqual({ passed: 1, n: 1, rate: 1 });
    expect(run.summary.refusal).toMatchObject({ passed: 0, n: 1 });
    expect(run.summary.clarify).toEqual({ passed: 1, n: 1, rate: 1 });
    expect(run.summary.fetchedUsable).toEqual({ passed: 2, n: 3, rate: 2 / 3 });
    expect(run.summary.latency.all).toMatchObject({ n: 2, p50Ms: 1_000, p90Ms: 3_000 });

    const report = renderReport([run], {
      datasetVersion: run.datasetVersion,
      datasetSha256: run.datasetSha256,
      runnerVersion: run.runnerVersion,
      rankings: ["rule"],
      llmProvider: "qwen",
      plannerModel: "qwen-plus",
      synthesisModel: "qwen-plus",
      searchProvider: "stub",
      rerankModel: null,
      caseCount: 3,
      runCount: 1,
      date: "2026-11-05",
      commits: { rule: "abc1234" },
      notes: [],
    });
    expect(report).toContain("| Citation verification pass rate | 100.0% (1/1) |");
    expect(report).toContain("| nos-01 | failed |");
  });

  it("summarizes rerank calls, fallbacks and changed selections", async () => {
    const base: AgentTrace = { answerMode: "research", queries: [], searchResultCount: 8, rankedUrls: [], sources: SOURCES, answer: "x [1]" };
    const reranks = {
      "ans-01": { ok: true, latencyMs: 300, candidates: 12, selected: 5, changedSelections: 2 },
      "nos-01": { ok: false, latencyMs: 900, candidates: 3, selected: 3, changedSelections: null, errorCode: "EGRESS_DENIED" },
    };
    const run = await runResearchEvaluation(
      dataset(),
      async (item) => ({ ...base, ...(item.caseId in reranks ? { rerank: reranks[item.caseId as keyof typeof reranks] } : {}) }),
      { ranking: "rerank" }
    );
    expect(run.summary.rerank).toMatchObject({
      calls: 2,
      failed: 1,
      latency: { n: 2, p50Ms: 300, p90Ms: 900 },
      casesWithChangedSelection: { passed: 1, n: 1 },
    });
  });

  it("marks a case that exceeds its timeout", async () => {
    const run = await runResearchEvaluation(
      dataset(),
      (_item, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      { ranking: "rule", perCaseTimeoutMs: 5, caseIds: ["ans-01"] }
    );
    expect(run.observations).toHaveLength(1);
    expect(run.observations[0]).toMatchObject({ caseId: "ans-01", status: "timeout" });
  });
});
