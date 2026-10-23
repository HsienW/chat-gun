import { recordMetric } from "../platform/observability.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import type { KbSearchResult } from "./retrieval.js";

export interface CitationVerification {
  status: "verified" | "failed" | "no_citations";
  cited: string[];
  unresolved: string[];
}

const CITATION_MARKER = /\[(c\d+(?:\s*,\s*c\d+)*)\]/gu;

/**
 * Deterministic check that every citation marker in an answer resolves to evidence returned by
 * kb_search in the same turn. It never rewrites the answer.
 */
export function verifyAnswerCitations(answer: string, results: readonly KbSearchResult[]): CitationVerification {
  const cited = [...answer.matchAll(CITATION_MARKER)].flatMap((match) => match[1].split(/\s*,\s*/u));
  const unique = [...new Set(cited)];
  if (unique.length === 0) return { status: "no_citations", cited: [], unresolved: [] };
  const resolvable = new Set(
    results.flatMap((result) => (result.outcome === "evidence_found" ? result.citations.map((citation) => citation.citationId) : []))
  );
  const unresolved = unique.filter((citationId) => !resolvable.has(citationId));
  return { status: unresolved.length === 0 ? "verified" : "failed", cited: unique, unresolved };
}

/** Emits the observable failure event required when an answer cites evidence that does not exist. */
export async function reportCitationVerification(
  verification: CitationVerification,
  context?: ExecutionContext
): Promise<void> {
  if (verification.status !== "failed") return;
  await recordMetric(
    "knowledge.citation.verification.failed",
    { unresolvedCount: verification.unresolved.length, citedCount: verification.cited.length },
    context
  );
}
