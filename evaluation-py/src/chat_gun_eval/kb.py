"""Port of runner.ts summarize, stage-latency.ts and scorers.ts (KB evaluation)."""

import math
from collections.abc import Sequence

from .models import STAGES, JsonObject, KBCase, KBCompleted, KBRun, json_object


def mean(values: Sequence[float]) -> float | None:
    """scorers.ts mean: preserve input addition order and the empty-set null."""
    total = 0.0
    for value in values:
        total += value  # Python 3.12 sum() compensates rounding; TS reduce() does not.
    return total / len(values) if values else None


def percentile(values: Sequence[float], fraction: float) -> float | None:
    """scorers.ts percentile: nearest rank, not interpolated quantiles."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1)]


def summarize(results: Sequence[KBCase]) -> JsonObject:
    """runner.ts summarize; failures count in cases, never in metric denominators."""
    completed = [r for r in results if isinstance(r, KBCompleted)]
    answerable = [r for r in completed if r.expectedKind == "answerable"]
    abstain = [r for r in completed if r.expectedKind == "abstain"]
    answered = [r for r in answerable if not r.abstained]
    stages = {}
    for stage in STAGES:
        timings = [getattr(r.stageLatency, stage) for r in results if r.stageLatency is not None]
        values = [t.ms for t in timings if t.status == "completed" and t.ms is not None]
        stages[stage] = {
            "completed": len(values),
            "failed": sum(t.status == "failed" for t in timings),
            "notRun": sum(t.status == "not_run" for t in timings),
            "unmeasured": len(results) - len(timings),
            "p50Ms": percentile(values, 0.5),
            "p95Ms": percentile(values, 0.95),
        }
    retrieval = []
    for r in completed:
        t = r.stageLatency
        if t and t.embedding.status == "completed" and t.recall.status == "completed":
            assert t.embedding.ms is not None and t.recall.ms is not None
            rerank_ms = 0.0 if t.rerank.status == "not_run" else t.rerank.ms
            assert rerank_ms is not None
            retrieval.append(t.embedding.ms + t.recall.ms + rerank_ms)
    return json_object(
        {
            "stageLatency": stages,
            "retrievalP50Ms": percentile(retrieval, 0.5),
            "retrievalP95Ms": percentile(retrieval, 0.95),
            "degradedCases": sum(r.retrievalMode == "vector_only_degraded" for r in completed),
            "cases": len(results),
            "answerableCases": len(answerable),
            "abstainCases": len(abstain),
            "recallAt5": mean([r.recallAt5 or 0 for r in answerable]),
            "mrr": mean([r.reciprocalRank or 0 for r in answerable]),
            "citationAccuracy": mean([r.citationAccuracy or 0 for r in answered]),
            "faithfulness": mean([r.faithfulness for r in answered if r.faithfulness is not None]),
            "abstentionAccuracy": mean([float(r.abstained) for r in abstain]),
            "falseAbstentionRate": mean([float(r.abstained) for r in answerable]),
            "latencyP50Ms": percentile([r.latencyMs for r in completed], 0.5),
            "latencyP95Ms": percentile([r.latencyMs for r in completed], 0.95),
        }
    )


def rescore(run: KBRun) -> JsonObject:
    return json_object(
        {
            "dev": summarize([r for r in run.results if r.split == "dev"]),
            "test": summarize([r for r in run.results if r.split == "test"]),
            "all": summarize(run.results),
        }
    )
