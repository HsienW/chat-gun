import { getBooleanEnv } from "../platform/env.js";

/**
 * Citation guard for Deep Researcher web answers.
 *
 * research-eval-v1 (2026-11-05) showed synthesis citing sources whose fetch failed and writing
 * URLs that were never fetched. With the guard on (DEEP_RESEARCH_CITATION_GUARD, default true):
 * - the synthesis evidence numbers only usable sources and lists unusable ones without an index;
 * - after the model answers, every [n] marker that does not point at a usable source and every
 *   URL that is not a usable source's URL is removed, and the removals are reported.
 * The guard validates citations against graph state; it never adds citations or rewrites claims.
 */

export const CITATION_GUARD_ENV = "DEEP_RESEARCH_CITATION_GUARD";

export interface GuardSource {
  index: number;
  url: string;
  usable: boolean;
}

export interface CitationGuardReport {
  modified: boolean;
  removedMarkers: number[];
  removedUrls: string[];
}

export function isCitationGuardEnabled(): boolean {
  return getBooleanEnv(CITATION_GUARD_ENV, true);
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`）)\]（，。、；：！？「」【】《》]+/gu;
const TRAILING_URL_PUNCTUATION = /[).,;:!?'"]+$/u;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu;
const MARKER_GROUP = /\s?\[(\d+(?:\s*(?:[,，、]|[-–])\s*\d+)*)\]/gu;

export function normalizeCitationUrl(raw: string): string {
  const trimmed = raw.replace(TRAILING_URL_PUNCTUATION, "");
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch {
    return trimmed;
  }
}

function expandMarkerGroup(group: string): number[] | null {
  const values: number[] = [];
  for (const part of group.split(/[,，、]/u)) {
    const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/u);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (end < start || end - start > 20) return null;
      for (let value = start; value <= end; value += 1) values.push(value);
    } else if (/^\d+$/u.test(part.trim())) {
      values.push(Number(part.trim()));
    } else {
      return null;
    }
  }
  return values;
}

/** Lines that held only a removed URL (a bullet, an arrow) are dropped instead of left empty. */
function dropEmptiedLines(original: string, guarded: string): string {
  const before = original.split("\n");
  const after = guarded.split("\n");
  if (before.length !== after.length) return guarded;
  return after
    .filter((line, index) => !(before[index].trim() && /^[\s\-*•·👉➜→:：]*$/u.test(line)))
    .join("\n");
}

export function guardCitations(answer: string, sources: readonly GuardSource[]): { answer: string; report: CitationGuardReport } {
  const usableIndexes = new Set(sources.filter((source) => source.usable).map((source) => source.index));
  const usableUrls = new Set(sources.filter((source) => source.usable).map((source) => normalizeCitationUrl(source.url)));
  const removedMarkers = new Set<number>();
  const removedUrls = new Set<string>();

  let guarded = answer.replace(MARKDOWN_LINK, (match, text: string, url: string) => {
    if (usableUrls.has(normalizeCitationUrl(url))) return match;
    removedUrls.add(normalizeCitationUrl(url));
    return text;
  });

  guarded = guarded.replace(URL_PATTERN, (match) => {
    const trailing = match.match(TRAILING_URL_PUNCTUATION)?.[0] ?? "";
    const normalized = normalizeCitationUrl(match);
    if (usableUrls.has(normalized)) return match;
    removedUrls.add(normalized);
    return trailing;
  });

  guarded = guarded.replace(MARKER_GROUP, (match, group: string) => {
    const values = expandMarkerGroup(group);
    if (!values || values.some((value) => value > 99)) return match;
    const kept = values.filter((value) => usableIndexes.has(value));
    for (const value of values) if (!usableIndexes.has(value)) removedMarkers.add(value);
    if (kept.length === values.length) return match;
    if (kept.length === 0) return "";
    return `${match.startsWith(" ") ? " " : ""}${kept.map((value) => `[${value}]`).join("")}`;
  });

  if (removedUrls.size > 0) {
    // research-eval-v1 guard run: 5/26 answers kept "官網（）" or "官網：，" after a URL was removed.
    guarded = guarded
      .replace(/\s*(?:（\s*）|\(\s*\))/gu, "")
      .replace(/[：:][ \t]*(?=[，,。；;])/gu, "")
      .replace(/[ \t]+$/gmu, "");
  }
  guarded = dropEmptiedLines(answer, guarded);
  const modified = guarded !== answer;
  return {
    answer: modified ? guarded : answer,
    report: {
      modified,
      removedMarkers: [...removedMarkers].sort((left, right) => left - right),
      removedUrls: [...removedUrls],
    },
  };
}
