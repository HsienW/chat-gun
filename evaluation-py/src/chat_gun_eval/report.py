"""Deterministic comparison of all summary leaves; never print question/answer/evidence."""

import os
import tempfile
from pathlib import Path

from pydantic import JsonValue

from .models import KBCompleted, KBRun, json_object
from .parity import recorded
from .reader import InputError, LoadedRun, safe_path

PROVENANCE_FIELDS = (
    "datasetVersion",
    "corpusVersion",
    "datasetSha256",
    "split",
    "embeddingModel",
    "embeddingSpaceId",
    "rerankModel",
    "generationModel",
    "judgeModel",
    "plannerModel",
    "synthesisModel",
    "llmProvider",
    "generationProvider",
    "configuredGenerationModel",
    "actualGenerationModel",
    "generationThinkingEnabled",
    "thinkingEnabled",
    "generationEndpointHost",
    "endpointHost",
    "answerPromptVersion",
    "judgePromptVersion",
    "thresholdVersion",
    "configVersion",
    "runnerVersion",
    "runCount",
    "date",
)


def leaves(value: JsonValue, prefix: str = "") -> dict[str, JsonValue]:
    if isinstance(value, dict):
        return {
            p: leaf
            for key in sorted(value)
            for p, leaf in leaves(value[key], f"{prefix}.{key}" if prefix else key).items()
        }
    if isinstance(value, list):
        return {
            p: leaf
            for i, item in enumerate(value)
            for p, leaf in leaves(item, f"{prefix}[{i}]").items()
        }
    return {prefix: value}


def cell(value: JsonValue) -> str:
    if value is None:
        return "null"
    if isinstance(value, float):
        return f"{value:.9f}"
    return str(value).replace("|", r"\|").replace("\r", r"\r").replace("\n", r"\n")


def sample_size(loaded: LoadedRun, metric: str) -> int:
    """Metric populations mirror TS summarize/report.ts sampleSize and summarizeRun."""
    parts = metric.split(".")
    if isinstance(loaded.run, KBRun):
        split, key = parts[:2]
        cases = [r for r in loaded.run.results if split == "all" or r.split == split]
        completed = [r for r in cases if isinstance(r, KBCompleted)]
        answerable = [r for r in completed if r.expectedKind == "answerable"]
        answered = [r for r in answerable if not r.abstained]
        if key in {"recallAt5", "mrr", "falseAbstentionRate"}:
            return len(answerable)
        if key == "citationAccuracy":
            return len(answered)
        if key == "faithfulness":
            return sum(r.faithfulness is not None for r in answered)
        if key == "abstentionAccuracy":
            return sum(r.expectedKind == "abstain" for r in completed)
        if key.startswith("latency"):
            return len(completed)
        if key.startswith("retrieval"):
            return sum(
                r.stageLatency is not None
                and r.stageLatency.embedding.status == "completed"
                and r.stageLatency.recall.status == "completed"
                for r in completed
            )
        if key == "stageLatency" and parts[-1] in {"p50Ms", "p95Ms"}:
            return sum(
                r.stageLatency is not None
                and getattr(r.stageLatency, parts[2]).status == "completed"
                for r in cases
            )
        return len(cases)
    summary = recorded(loaded)
    # Rate and latency structures explicitly carry their own denominator n.
    current: JsonValue = summary
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            break
        current = current[part]
    if isinstance(current, dict) and isinstance(current.get("n"), int):
        n = current["n"]
        assert isinstance(n, int)
        return n
    observations = loaded.run.observations
    completed_research = [o for o in observations if o.status == "completed"]
    if metric.startswith("citation.answerable"):
        return sum(o.category == "answerable" for o in completed_research)
    if metric.startswith("routing."):
        return len(completed_research)
    if metric.startswith("rerank."):
        return sum(o.rerank is not None for o in completed_research)
    if metric.startswith("citationGuard."):
        return sum(o.citationGuard is not None for o in completed_research)
    return len(observations)


def compare(runs: list[LoadedRun], *, allow_cross_version: bool = False) -> str:
    if len(runs) < 2:
        raise InputError("compare requires at least two runs")
    if len({r.kind for r in runs}) != 1:
        raise InputError("compare requires runs of the same evaluation type")
    cross = len({r.versions for r in runs}) != 1
    if cross and not allow_cross_version:
        raise InputError(
            "datasetVersion/corpusVersion differ: " + ", ".join(str(r.versions) for r in runs)
        )
    title = "# 評測比較" + (" — 跨資料集版本" if cross else "")
    lines = [
        title,
        "",
        "小樣本，一兩題的差異應視為雜訊。",
        "",
        "基準：第一個 run。n 為各指標實際計算的樣本母體；null 表示沒有可計算值。",
        "",
        "## Provenance",
        "",
        "| 欄位 | " + " | ".join(f"run {i + 1}" for i in range(len(runs))) + " |",
        "|---|" + "---|" * len(runs),
        "| run | " + " | ".join(cell(r.name) for r in runs) + " |",
    ]
    provenance = [
        json_object(r.provenance.model_dump(mode="json", exclude_unset=True)) for r in runs
    ]
    for key in PROVENANCE_FIELDS:
        lines.append(
            "| "
            + key
            + " | "
            + " | ".join(cell(p[key]) if key in p else "未記錄" for p in provenance)
            + " |"
        )
    summaries = [leaves(recorded(r)) for r in runs]
    lines += [
        "",
        "## 指標",
        "",
        "| 指標／split | run | 值 | 相對基準差異 | n |",
        "|---|---|---|---|---|",
    ]
    for metric in sorted({k for summary in summaries for k in summary}):
        baseline = summaries[0].get(metric)
        for i, (run, summary) in enumerate(zip(runs, summaries, strict=True)):
            value = summary.get(metric)
            delta = (
                f"{value - baseline:+.9f}"
                if isinstance(value, (int, float))
                and not isinstance(value, bool)
                and isinstance(baseline, (int, float))
                and not isinstance(baseline, bool)
                else "—"
            )
            shown = cell(value) if metric in summary else "未記錄"
            lines.append(
                f"| {cell(metric)} | run {i + 1} | {shown} | {delta} | {sample_size(run, metric)} |"
            )
    return "\n".join([*lines, ""])


def atomic_write(path: Path, content: str, protected: list[Path] | None = None) -> None:
    path = safe_path(path)
    if path in {safe_path(p) for p in protected or []}:
        raise InputError(f"{path}: refusing to overwrite an input file")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix="." + path.name + ".",
            delete=False,
        ) as file:
            temporary = Path(file.name)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
