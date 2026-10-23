/**
 * Programmatic retrieval scorers. All operate on source identities: a case is about which
 * sources answer it, and one source may produce several chunks.
 */

/** Unique source ids in first-seen rank order. */
export function rankedSources(sourceIds: readonly string[]): string[] {
  return [...new Set(sourceIds)];
}

/** Share of relevant sources found among the top-k ranked sources. */
export function recallAtK(retrieved: readonly string[], relevant: readonly string[], k = 5): number {
  if (relevant.length === 0) throw new Error("recallAtK requires at least one relevant source");
  const top = new Set(rankedSources(retrieved).slice(0, k));
  return relevant.filter((sourceId) => top.has(sourceId)).length / relevant.length;
}

/** Reciprocal rank of the first relevant source; 0 when none was retrieved. */
export function reciprocalRank(retrieved: readonly string[], relevant: readonly string[]): number {
  const relevantSet = new Set(relevant);
  const index = rankedSources(retrieved).findIndex((sourceId) => relevantSet.has(sourceId));
  return index === -1 ? 0 : 1 / (index + 1);
}

export interface CitationJudgement {
  citationId: string;
  resolvable: boolean;
  sourceId?: string;
  relevant: boolean;
}

/**
 * Citation accuracy: share of cited ids that resolve to returned evidence AND belong to a relevant
 * source. An answer without any citation scores 0 because it cannot be verified.
 */
export function citationAccuracy(
  citedIds: readonly string[],
  evidence: ReadonlyMap<string, string>,
  relevant: readonly string[]
): { value: number; judgements: CitationJudgement[] } {
  const relevantSet = new Set(relevant);
  const judgements = [...new Set(citedIds)].map((citationId) => {
    const sourceId = evidence.get(citationId);
    return {
      citationId,
      resolvable: sourceId !== undefined,
      ...(sourceId !== undefined ? { sourceId } : {}),
      relevant: sourceId !== undefined && relevantSet.has(sourceId),
    };
  });
  if (judgements.length === 0) return { value: 0, judgements };
  return { value: judgements.filter((judgement) => judgement.relevant).length / judgements.length, judgements };
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}
