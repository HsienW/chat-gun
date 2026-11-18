import json
from pathlib import Path

import pytest

from chat_gun_eval.kb import rescore as kb_rescore
from chat_gun_eval.models import KBRun, Observation
from chat_gun_eval.research import score_case, summarize_run

REPO = Path(__file__).resolve().parents[2]
ROOTS = [REPO / "backend/data/knowledge-eval/results", REPO / "backend/data/research-eval/results"]
RUN_FILES = sorted(path for root in ROOTS for path in root.glob("*/run-*.json"))


def write_run(directory: Path, data: dict[str, object], *, version: str = "fixture-v1") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / "run-fixture.json"
    file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    provenance = {
        "datasetVersion": version,
        "corpusVersion": "corpus-v1",
        "generationModel": "fixture-model",
        "date": "2026-01-01",
    }
    (directory / "provenance.json").write_text(json.dumps(provenance), encoding="utf-8")
    return file


def kb_data() -> dict[str, object]:
    case = {
        "caseId": "fixture-1",
        "split": "test",
        "expectedKind": "answerable",
        "status": "completed",
        "latencyMs": 2,
        "retrievalMode": "vector_only",
        "kbOutcome": "evidence_found",
        "rankedSourceIds": ["a"],
        "candidateScores": [],
        "abstained": False,
        "recallAt5": 1,
        "reciprocalRank": 1,
        "citationAccuracy": 1,
        "faithfulness": 0.5,
        "question": "PRIVATE_QUESTION_SENTINEL",
        "answer": "PRIVATE_ANSWER_SENTINEL",
        "evidence": [{"content": "PRIVATE_EVIDENCE_SENTINEL"}],
    }
    # Fixtures use the public scorer to build valid transport; scorer semantics have separate
    # hand-calculated tests and the recorded TS run corpus is the independent parity oracle.
    summary = {
        "cases": 0,
        "answerableCases": 0,
        "abstainCases": 0,
        "recallAt5": None,
        "mrr": None,
        "citationAccuracy": None,
        "faithfulness": None,
        "abstentionAccuracy": None,
        "falseAbstentionRate": None,
        "latencyP50Ms": None,
        "latencyP95Ms": None,
    }
    data = {
        "strategy": "vector_only",
        "status": "completed",
        "failedCases": [],
        "results": [case],
        "summary": {s: summary for s in ["dev", "test", "all"]},
    }
    run = KBRun.model_validate_json(json.dumps(data))
    data["summary"] = kb_rescore(run)
    return data


def research_observation(**overrides: object) -> Observation:
    data = {
        "caseId": "research-1",
        "category": "answerable",
        "status": "completed",
        "latencyMs": 2,
        "answerMode": "research",
        "queries": [],
        "searchResultCount": 1,
        "rankedUrls": [],
        "sources": [{"index": 1, "url": "https://example.test/a", "usable": True}],
        "answer": "Fact [1]",
    }
    data.update(overrides)
    return Observation.model_validate_json(json.dumps(data))


def research_data(**overrides: object) -> dict[str, object]:
    observation = research_observation(**overrides)
    score = score_case(observation)
    return {
        "runnerVersion": "research-eval-runner-v1",
        "datasetVersion": "fixture-v1",
        "ranking": "rule",
        "observations": [observation.model_dump(exclude_unset=True)],
        "scores": [score.model_dump(by_alias=True, exclude_none=True)],
        "summary": summarize_run([observation], [score]),
    }


@pytest.fixture
def kb_file(tmp_path: Path) -> Path:
    return write_run(tmp_path / "first", kb_data())
