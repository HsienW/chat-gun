import { afterEach, describe, expect, it, vi } from "vitest";

import { guardCitations, isCitationGuardEnabled, type GuardSource } from "./deep-researcher-citation-guard.js";

const sources: GuardSource[] = [
  { index: 1, url: "https://example.com/a", usable: true },
  { index: 2, url: "https://example.org/b/", usable: false },
  { index: 3, url: "https://docs.example.net/c", usable: true },
];

afterEach(() => vi.unstubAllEnvs());

describe("deep researcher citation guard", () => {
  it("is on unless DEEP_RESEARCH_CITATION_GUARD is false", () => {
    expect(isCitationGuardEnabled()).toBe(true);
    vi.stubEnv("DEEP_RESEARCH_CITATION_GUARD", "false");
    expect(isCitationGuardEnabled()).toBe(false);
  });

  it("leaves an answer that cites only usable sources untouched", () => {
    const answer = "Fact one [1]. Fact two [1, 3]. See https://example.com/a and https://docs.example.net/c/.";
    expect(guardCitations(answer, sources)).toEqual({
      answer,
      report: { modified: false, removedMarkers: [], removedUrls: [] },
    });
  });

  it("removes markers that point at unusable or missing sources", () => {
    const result = guardCitations("Claim A [2]. Claim B [1][2]. Claim C [1, 2, 9]. Range [1-3].", sources);
    expect(result.answer).toBe("Claim A. Claim B [1]. Claim C [1]. Range [1][3].");
    expect(result.report).toEqual({ modified: true, removedMarkers: [2, 9], removedUrls: [] });
  });

  it("removes unfetched URLs, unwraps their markdown links and drops emptied bullet lines", () => {
    const answer = [
      "Official notes ([release](https://github.com/x/y/releases/tag/v1)) and [docs](https://example.com/a).",
      "Visit:",
      "- https://kubernetes.io/releases/（官方發布日曆）",
      "- https://unknown.example/path",
      "👉 https://www.cbc.gov.tw",
    ].join("\n");
    const result = guardCitations(answer, sources);
    expect(result.answer).toBe(
      ["Official notes (release) and [docs](https://example.com/a).", "Visit:", "- （官方發布日曆）"].join("\n")
    );
    expect(result.report.removedUrls).toEqual([
      "https://github.com/x/y/releases/tag/v1",
      "https://kubernetes.io/releases",
      "https://unknown.example/path",
      "https://www.cbc.gov.tw",
    ]);
  });

  it("strips every citation when there is no usable source", () => {
    const result = guardCitations("No usable sources were retrieved [1][2]; see https://example.com/a.", [
      { index: 1, url: "https://example.com/a", usable: false },
    ]);
    expect(result.answer).toBe("No usable sources were retrieved; see .");
    expect(result.report).toMatchObject({ modified: true, removedMarkers: [1, 2], removedUrls: ["https://example.com/a"] });
  });

  it("does not treat years or long ranges as citation markers", () => {
    const answer = "Released in [2026] per the [1-40] appendix.";
    expect(guardCitations(answer, sources).answer).toBe(answer);
  });
});
