import { afterEach, describe, expect, it, vi } from "vitest";

import { isSourceRerankEnabled, rerankCandidates, sourceRerankDocument, type RankCandidate } from "./deep-researcher-source-rerank.js";

const candidates: RankCandidate[] = [
  { title: "Rule first", url: "https://a.example", snippet: "keyword stuffing", score: 30, rankReason: "3 query term hits" },
  { title: "Rule second", url: "https://b.example", snippet: "official release notes", score: 20, rankReason: "2 query term hits" },
  { title: "Rule third", url: "https://c.example", snippet: "forum thread", score: 10, rankReason: "1 query term hits" },
];

afterEach(() => vi.unstubAllEnvs());

describe("deep researcher source rerank", () => {
  it("is off unless DEEP_RESEARCH_SOURCE_RERANK is true", () => {
    expect(isSourceRerankEnabled()).toBe(false);
    vi.stubEnv("DEEP_RESEARCH_SOURCE_RERANK", "true");
    expect(isSourceRerankEnabled()).toBe(true);
  });

  it("keeps the rule order without calling the reranker when disabled", async () => {
    const reranker = vi.fn();
    const result = await rerankCandidates("q", candidates, { enabled: false, reranker });
    expect(reranker).not.toHaveBeenCalled();
    expect(result.ranked.map((item) => item.url)).toEqual(candidates.map((item) => item.url));
    expect(result.outcome).toEqual({ strategy: "rule", reason: "disabled" });
  });

  it("reorders by rerank score and keeps unscored candidates after scored ones", async () => {
    const reranker = vi.fn(async () => [
      { index: 1, score: 0.91 },
      { index: 0, score: 0.12 },
    ]);
    let clock = 100;
    const result = await rerankCandidates("What changed?", candidates, { enabled: true, reranker, now: () => (clock += 40) });
    expect(reranker).toHaveBeenCalledWith("What changed?", candidates.map(sourceRerankDocument), undefined);
    expect(result.ranked.map((item) => item.url)).toEqual(["https://b.example", "https://a.example", "https://c.example"]);
    expect(result.ranked[0].rankReason).toBe("rerank 0.910; rule 20 (2 query term hits)");
    expect(result.ranked[2].rankReason).toBe("1 query term hits");
    expect(result.outcome).toEqual({ strategy: "rerank", latencyMs: 40 });
  });

  it.each([
    ["provider error", async () => { throw Object.assign(new Error("denied"), { code: "EGRESS_DENIED" }); }, "EGRESS_DENIED"],
    ["empty scores", async () => [], "RERANK_EMPTY"],
    ["out-of-range indexes", async () => [{ index: 7, score: 0.9 }], "RERANK_EMPTY"],
  ])("falls back to the rule order on %s", async (_label, reranker, code) => {
    const result = await rerankCandidates("q", candidates, { enabled: true, reranker });
    expect(result.ranked.map((item) => item.url)).toEqual(candidates.map((item) => item.url));
    expect(result.outcome).toMatchObject({ strategy: "rule", reason: "fallback", errorCode: code });
  });

  it("bounds the document to title and snippet", () => {
    expect(sourceRerankDocument({ title: "T", snippet: "x".repeat(2_000) })).toHaveLength(1_000);
    expect(sourceRerankDocument({ title: "", snippet: "" })).toBe("(empty)");
  });
});
