import type { ResearchEvalCategory, ResearchEvalStub } from "./dataset.js";

/**
 * Scoring for the Deep Researcher evaluation. Every function here is pure so the metric
 * definitions can be tested offline and re-applied to a stored run.
 *
 * Metric definitions (also rendered into report.md):
 * - Citation verification pass: an answer that cites at least once passes only when every
 *   bracket marker [n] resolves to an extracted source marked usable and every raw URL in the
 *   answer belongs to a usable source. Answers without any citation are reported separately.
 * - No-source refusal pass: the run had zero usable sources, the answer states the limitation,
 *   and the answer cites no evidence marker [n]. Raw URLs (often "check the official site"
 *   pointers) are listed for the manual fabrication check instead of failing the case.
 * - Clarify pass: the planner routed the request to answerMode=clarify.
 * - Latency: wall-clock time of one graph invocation; percentiles use the nearest-rank method.
 */

export interface ObservedSource {
  index: number;
  url: string;
  usable: boolean;
  fetchError?: string;
}

export type CaseStatus = "completed" | "failed" | "timeout";

export interface CaseObservation {
  caseId: string;
  category: ResearchEvalCategory;
  stub?: ResearchEvalStub;
  status: CaseStatus;
  error?: string;
  latencyMs: number;
  answerMode?: string;
  queries: string[];
  searchResultCount: number;
  rankedUrls: string[];
  sources: ObservedSource[];
  answer: string;
  /** Present when the run had source rerank enabled and the graph reached rankSources. */
  rerank?: RerankObservation;
  /** Present when the citation guard ran on a research answer; the answer above is post-guard. */
  citationGuard?: { modified: boolean; removedMarkers: number; removedUrls: number };
}

export interface RerankObservation {
  ok: boolean;
  latencyMs: number;
  candidates: number;
  /** Sources the graph kept after ranking (top-N). */
  selected: number;
  /** How many of the rerank top-N were outside the rule-order top-N on the same candidates. */
  changedSelections: number | null;
  errorCode?: string;
}

export interface CitationScore {
  markers: number[];
  urls: string[];
  citedCount: number;
  usableCitedCount: number;
  unresolved: string[];
  /** null when the answer cites nothing. */
  pass: boolean | null;
}

export interface RefusalScore {
  usableSourceCount: number;
  limitationStated: boolean;
  citedEvidence: boolean;
  urlsMentioned: string[];
  pass: boolean;
}

export interface CaseScore {
  caseId: string;
  category: ResearchEvalCategory;
  citation: CitationScore;
  refusal?: RefusalScore;
  clarifyPass?: boolean;
}

const MAX_SOURCE_INDEX = 99;

export function extractCitationMarkers(answer: string): number[] {
  const markers = new Set<number>();
  for (const match of answer.matchAll(/\[([\d\s,，、\-–]+)\]/gu)) {
    for (const part of match[1].split(/[,，、]/u)) {
      const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/u);
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])];
        if (end >= start && end - start <= 20) {
          for (let value = start; value <= end; value += 1) markers.add(value);
        }
        continue;
      }
      const single = part.trim();
      if (/^\d+$/u.test(single)) markers.add(Number(single));
    }
  }
  return [...markers].filter((value) => value >= 1 && value <= MAX_SOURCE_INDEX).sort((a, b) => a - b);
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.replace(/[)\]>.,;:!?'"，。）]+$/u, "");
  try {
    const url = new URL(trimmed);
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return trimmed;
  }
}

export function extractUrls(answer: string): string[] {
  // Full-width punctuation ends a URL: answers often write "https://host/path（說明）".
  return [...new Set([...answer.matchAll(/https?:\/\/[^\s<>"'`）)\]（，。、；：！？「」【】《》]+/gu)].map((match) => normalizeUrl(match[0])))];
}

export function scoreCitations(answer: string, sources: readonly ObservedSource[]): CitationScore {
  const markers = extractCitationMarkers(answer);
  const urls = extractUrls(answer);
  const byIndex = new Map(sources.map((source) => [source.index, source]));
  const usableUrls = new Set(sources.filter((source) => source.usable).map((source) => normalizeUrl(source.url)));
  const unresolved: string[] = [];
  let usableCitedCount = 0;

  for (const marker of markers) {
    if (byIndex.get(marker)?.usable) usableCitedCount += 1;
    else unresolved.push(`[${marker}]`);
  }
  for (const url of urls) {
    if (usableUrls.has(url)) usableCitedCount += 1;
    else unresolved.push(url);
  }

  const citedCount = markers.length + urls.length;
  return {
    markers,
    urls,
    citedCount,
    usableCitedCount,
    unresolved,
    pass: citedCount === 0 ? null : unresolved.length === 0,
  };
}

const LIMITATION_PATTERNS = [
  /no usable (?:sources?|evidence|results?)/iu,
  /no (?:relevant |search )?results/iu,
  /(?:could not|couldn['’]t|cannot|can['’]t|unable to|was unable to|were unable to|not able to) (?:be )?(?:find|retriev|fetch|access|locat|verif|confirm|provid|report|answer|determin)/iu,
  /(?:search|fetch|retrieval|tool)[^.\n]{0,40}(?:fail|error|unavailable|returned no)/iu,
  /\bfailed to\b/iu,
  /insufficient (?:evidence|sources|information)/iu,
  /無法|无法|未能|沒有(?:找到|可用|取得|檢索|搜尋到)|没有(?:找到|可用|取得|检索|搜索到)|未(?:找到|檢索到|检索到|取得)|(?:搜尋|搜索|檢索|检索|抓取|擷取|获取|取得)[^。\n]{0,12}(?:失敗|失败|為空|为空)/u,
];

export function statesLimitation(answer: string): boolean {
  return LIMITATION_PATTERNS.some((pattern) => pattern.test(answer));
}

export function scoreCase(observation: CaseObservation): CaseScore {
  const citation = scoreCitations(observation.answer, observation.sources);
  const score: CaseScore = { caseId: observation.caseId, category: observation.category, citation };
  if (observation.category === "no_source") {
    const usableSourceCount = observation.sources.filter((source) => source.usable).length;
    const limitationStated = statesLimitation(observation.answer);
    const citedEvidence = citation.markers.length > 0;
    score.refusal = {
      usableSourceCount,
      limitationStated,
      citedEvidence,
      urlsMentioned: citation.urls,
      pass: observation.status === "completed" && usableSourceCount === 0 && limitationStated && !citedEvidence,
    };
  }
  if (observation.category === "clarify") {
    score.clarifyPass = observation.status === "completed" && observation.answerMode === "clarify";
  }
  return score;
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

export interface LatencySummary {
  n: number;
  p50Ms: number | null;
  p90Ms: number | null;
  meanMs: number | null;
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  return {
    n: values.length,
    p50Ms: nearestRankPercentile(values, 50),
    p90Ms: nearestRankPercentile(values, 90),
    meanMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
  };
}

export interface Rate {
  passed: number;
  n: number;
  rate: number | null;
}

function rate(passed: number, n: number): Rate {
  return { passed, n, rate: n === 0 ? null : passed / n };
}

export interface RunSummary {
  cases: number;
  completed: number;
  failedOrTimeout: number;
  citation: {
    /** Answerable answers that cite at least once. */
    answerPassRate: Rate;
    /** Individual citations (markers + URLs) that resolve to a usable source. */
    citationPrecision: Rate;
    answerableWithoutCitation: number;
    answerableWithZeroUsableSources: number;
    /** All completed answers in any category, so failures outside answerable cases are visible. */
    allCategoriesAnswerPassRate: Rate;
  };
  refusal: Rate & { stubEffective: number };
  clarify: Rate;
  fetchedUsable: Rate;
  routing: Record<string, number>;
  latency: { all: LatencySummary } & Partial<Record<ResearchEvalCategory, LatencySummary>>;
  rerank?: {
    calls: number;
    failed: number;
    latency: LatencySummary;
    /** Cases where rerank changed at least one fetched source versus the rule order. */
    casesWithChangedSelection: Rate;
  };
  citationGuard?: {
    /** Research answers the guard changed, over research answers it ran on. */
    answersModified: Rate;
    removedMarkers: number;
    removedUrls: number;
  };
}

export function summarizeRun(observations: readonly CaseObservation[], scores: readonly CaseScore[]): RunSummary {
  const scoreById = new Map(scores.map((score) => [score.caseId, score]));
  const completed = observations.filter((observation) => observation.status === "completed");
  const answerable = completed.filter((observation) => observation.category === "answerable");
  const answerableScores = answerable.map((observation) => scoreById.get(observation.caseId)!);
  const citing = answerableScores.filter((score) => score.citation.pass !== null);
  const allCiting = completed.map((observation) => scoreById.get(observation.caseId)!).filter((score) => score.citation.pass !== null);

  const noSource = observations.filter((observation) => observation.category === "no_source");
  const noSourceScores = noSource.map((observation) => scoreById.get(observation.caseId)!.refusal!);
  const clarify = observations.filter((observation) => observation.category === "clarify");

  const fetched = answerable.flatMap((observation) => observation.sources);
  const routing: Record<string, number> = {};
  for (const observation of completed) {
    const key = `${observation.category}:${observation.answerMode ?? "unknown"}`;
    routing[key] = (routing[key] ?? 0) + 1;
  }

  const latency: RunSummary["latency"] = { all: summarizeLatency(completed.map((observation) => observation.latencyMs)) };
  for (const category of ["answerable", "no_source", "clarify"] as const) {
    latency[category] = summarizeLatency(
      completed.filter((observation) => observation.category === category).map((observation) => observation.latencyMs)
    );
  }

  const reranked = completed.filter((observation) => observation.rerank !== undefined);
  const rerankSummary: RunSummary["rerank"] = reranked.length
    ? {
        calls: reranked.length,
        failed: reranked.filter((observation) => !observation.rerank!.ok).length,
        latency: summarizeLatency(reranked.map((observation) => observation.rerank!.latencyMs)),
        casesWithChangedSelection: rate(
          reranked.filter((observation) => (observation.rerank!.changedSelections ?? 0) > 0).length,
          reranked.filter((observation) => observation.rerank!.ok).length
        ),
      }
    : undefined;

  const guarded = completed.filter((observation) => observation.citationGuard !== undefined);
  const guardSummary: RunSummary["citationGuard"] = guarded.length
    ? {
        answersModified: rate(guarded.filter((observation) => observation.citationGuard!.modified).length, guarded.length),
        removedMarkers: guarded.reduce((sum, observation) => sum + observation.citationGuard!.removedMarkers, 0),
        removedUrls: guarded.reduce((sum, observation) => sum + observation.citationGuard!.removedUrls, 0),
      }
    : undefined;

  return {
    ...(rerankSummary ? { rerank: rerankSummary } : {}),
    ...(guardSummary ? { citationGuard: guardSummary } : {}),
    cases: observations.length,
    completed: completed.length,
    failedOrTimeout: observations.length - completed.length,
    citation: {
      answerPassRate: rate(citing.filter((score) => score.citation.pass).length, citing.length),
      citationPrecision: rate(
        citing.reduce((sum, score) => sum + score.citation.usableCitedCount, 0),
        citing.reduce((sum, score) => sum + score.citation.citedCount, 0)
      ),
      answerableWithoutCitation: answerable.filter(
        (observation) =>
          scoreById.get(observation.caseId)!.citation.pass === null && observation.sources.some((source) => source.usable)
      ).length,
      answerableWithZeroUsableSources: answerable.filter((observation) => !observation.sources.some((source) => source.usable)).length,
      allCategoriesAnswerPassRate: rate(allCiting.filter((score) => score.citation.pass).length, allCiting.length),
    },
    refusal: {
      ...rate(noSourceScores.filter((score) => score.pass).length, noSource.length),
      stubEffective: noSourceScores.filter((score) => score.usableSourceCount === 0).length,
    },
    clarify: rate(clarify.filter((observation) => scoreById.get(observation.caseId)!.clarifyPass).length, clarify.length),
    fetchedUsable: rate(fetched.filter((source) => source.usable).length, fetched.length),
    routing,
    latency,
  };
}
