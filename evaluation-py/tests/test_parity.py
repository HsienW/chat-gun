import hashlib
import json
from pathlib import Path

import pytest
from conftest import RUN_FILES, kb_data, research_data, research_observation, write_run

from chat_gun_eval.cli import main
from chat_gun_eval.models import STAGES, KBCompleted, Timing
from chat_gun_eval.parity import check, differences, exceptions, recompute
from chat_gun_eval.reader import InputError, read_run
from chat_gun_eval.research import (
    extract_citation_markers,
    extract_urls,
    nearest_rank_percentile,
    normalize_url,
    score_case,
    score_citations,
    states_limitation,
    summarize_latency,
    summarize_run,
)


def test_fixed_typescript_reference() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures/ts-research.json").read_text(encoding="utf-8")
    )
    for entry in fixture["urls"]:
        assert normalize_url(entry["raw"]) == entry["normalized"]
    for entry in fixture["markers"]:
        assert extract_citation_markers(entry["answer"]) == entry["markers"]
    observations = [research_observation(**item) for item in fixture["observations"]]
    scores = [score_case(o) for o in observations]
    assert [s.model_dump(by_alias=True, exclude_unset=True) for s in scores] == fixture["scores"]
    assert not differences(fixture["summary"], summarize_run(observations, scores))


@pytest.mark.parametrize(
    ("field", "value"),
    [("category", "unknown"), ("status", "unknown"), ("latencyMs", "2"), ("sources", {})],
)
def test_research_input_validation(tmp_path: Path, capsys, field: str, value: object) -> None:
    data = research_data()
    data["observations"][0][field] = value
    file = write_run(tmp_path / field, data)
    assert main(["parity", str(file)]) == 2
    assert f"observations.0.{field}" in capsys.readouterr().err


def test_provenance_validation_has_its_filename(kb_file: Path, capsys) -> None:
    provenance = kb_file.parent / "provenance.json"
    provenance.write_text(json.dumps({"datasetVersion": 2}), encoding="utf-8")
    assert main(["parity", str(kb_file)]) == 2
    error = capsys.readouterr().err
    assert str(provenance) in error and "datasetVersion" in error


@pytest.mark.parametrize("field", ["rerank", "citationGuard", "answerMode", "stub"])
def test_observation_optional_does_not_mean_nullable(tmp_path: Path, field: str) -> None:
    data = research_data()
    data["observations"][0][field] = None
    with pytest.raises(InputError, match=f"observations.0.{field}"):
        read_run(write_run(tmp_path / field, data))


def test_candidate_score_required_fields(tmp_path: Path) -> None:
    data = kb_data()
    data["results"][0]["candidateScores"] = [{"sourceId": "a"}]
    with pytest.raises(InputError, match="candidateScores.0.similarity"):
        read_run(write_run(tmp_path / "candidates", data))


@pytest.mark.parametrize("path", RUN_FILES, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_all_recorded_typescript_runs(path: Path) -> None:
    before = path.read_bytes(), path.stat().st_mtime_ns
    loaded = read_run(path)
    outcome = check(loaded)
    assert not outcome.differences, "\n".join(outcome.differences)
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before


def test_corpus_is_present_and_named_exceptions_narrow() -> None:
    assert RUN_FILES, "Missing recorded evaluation corpus"
    names = {f"{p.parent.name}/{p.name}": p for p in RUN_FILES}
    for entry in exceptions():
        assert entry.reason and len(entry.sha256) == 64
        assert set(entry.sha256) <= set("0123456789abcdef")
        # Some local recorded runs are untracked, so a clean CI checkout lacks them.
        # An absent entry exempts nothing; every discovered run is still checked above.
        if entry.run in names:
            assert hashlib.sha256(names[entry.run].read_bytes()).hexdigest() == entry.sha256
        assert len(entry.missingPythonPaths) == 12
        assert all(
            p.rsplit(".", 1)[-1]
            in {"stageLatency", "retrievalP50Ms", "retrievalP95Ms", "degradedCases"}
            for p in entry.missingPythonPaths
        )


def test_changed_legacy_run_is_not_exempted(tmp_path: Path) -> None:
    source = next(p for p in RUN_FILES if p.name == "run-vector_only.json")
    target = tmp_path / source.parent.name
    target.mkdir()
    data = json.loads(source.read_text(encoding="utf-8"))
    data["summary"]["test"]["mrr"] = 999
    file = target / source.name
    file.write_text(json.dumps(data), encoding="utf-8")
    (target / "provenance.json").write_bytes((source.parent / "provenance.json").read_bytes())
    outcome = check(read_run(file))
    assert any("fingerprint differs" in d for d in outcome.differences)
    assert any("test.mrr" in d for d in outcome.differences)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("latencyMs", "wrong"),
        ("split", "unknown"),
        ("expectedKind", "unknown"),
        ("status", "unknown"),
    ],
)
def test_invalid_case_has_file_and_field_path(
    tmp_path: Path, capsys, path: str, value: str
) -> None:
    data = kb_data()
    data["results"][0][path] = value
    file = write_run(tmp_path / path, data)
    assert main(["parity", str(file)]) != 0
    error = capsys.readouterr().err
    assert str(file) in error and path in error


def test_missing_latency_and_unknown_additions(kb_file: Path) -> None:
    data = json.loads(kb_file.read_text(encoding="utf-8"))
    data["newOptional"] = {"future": 42}
    data["results"][0]["future"] = "ignored"
    kb_file.write_text(json.dumps(data), encoding="utf-8")
    assert not check(read_run(kb_file)).differences
    del data["results"][0]["latencyMs"]
    kb_file.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(InputError, match=r"results.0.completed.latencyMs"):
        read_run(kb_file)


def test_tampered_summary_fails_with_split_and_values(kb_file: Path, capsys) -> None:
    data = json.loads(kb_file.read_text(encoding="utf-8"))
    data["summary"]["test"]["mrr"] = 0.25
    kb_file.write_text(json.dumps(data), encoding="utf-8")
    assert main(["parity", str(kb_file)]) == 1
    output = capsys.readouterr().err
    assert "test.mrr" in output and "TS=0.25" in output and "Python=1.0" in output


def test_exact_numbers_null_missing_and_absolute_ratio_policy() -> None:
    assert not differences(1.0, 1.0 + 0.5e-9, "test.mrr")
    assert differences(1.0, 1.0 + 2e-9, "test.mrr")
    assert differences(1_000_000.0, 1_000_000.0001, "test.mrr")  # no relative tolerance
    assert differences(1, 1.0000000001, "cases")
    assert differences(1, 1.0000000001, "latency.p50Ms")
    assert differences({}, {"rerank": None})
    assert differences({"x": 1}, {})
    assert differences(True, 1)


def test_kb_denominators_empty_and_stage_latency(tmp_path: Path) -> None:
    from chat_gun_eval.kb import summarize

    data = kb_data()
    case = KBCompleted.model_validate_json(json.dumps(data["results"][0]))
    summary = summarize([case, case.model_copy(update={"abstained": True, "faithfulness": 0.9})])
    assert summary["citationAccuracy"] == 1 and summary["faithfulness"] == 0.5
    assert summary["falseAbstentionRate"] == 0.5
    assert summarize([])["mrr"] is None
    assert nearest_rank_percentile([1, 2, 3, 4], 50) == 2
    assert summarize_latency([2, 3])["meanMs"] == 3
    assert summarize_latency([0.49999999999999994])["meanMs"] == 0
    assert summarize_latency([float(2**52 + 1)])["meanMs"] == 2**52 + 1
    timing = {stage: {"status": "not_run"} for stage in STAGES}
    timing.update(
        {
            "embedding": {"status": "completed", "ms": 2},
            "recall": {"status": "completed", "ms": 3},
            "rerank": {"status": "failed", "ms": 4},
        }
    )
    data["results"][0]["stageLatency"] = timing
    loaded = read_run(write_run(tmp_path / "stages", data))
    result = recompute(loaded)["test"]
    assert result["retrievalP50Ms"] == 9  # includes failed rerank waiting time
    assert result["stageLatency"]["rerank"] == {
        "completed": 0,
        "failed": 1,
        "notRun": 0,
        "unmeasured": 0,
        "p50Ms": None,
        "p95Ms": None,
    }
    with pytest.raises(ValueError, match="ms is required"):
        Timing(status="completed")


@pytest.mark.parametrize("optional", [None, "rerank", "citationGuard"])
def test_research_optional_keys_and_tampering(tmp_path: Path, optional: str | None) -> None:
    kwargs = (
        {
            "rerank": {
                "ok": True,
                "latencyMs": 4,
                "candidates": 2,
                "selected": 1,
                "changedSelections": 1,
            }
        }
        if optional == "rerank"
        else {"citationGuard": {"modified": True, "removedMarkers": 1, "removedUrls": 2}}
        if optional
        else {}
    )
    data = research_data(**kwargs)
    file = write_run(tmp_path / str(optional), data)
    assert not check(read_run(file)).differences
    actual = recompute(read_run(file))
    assert ("rerank" in actual) == (optional == "rerank")
    assert ("citationGuard" in actual) == (optional == "citationGuard")
    data["summary"]["completed"] = 99
    file.write_text(json.dumps(data), encoding="utf-8")
    assert any("completed" in d for d in check(read_run(file)).differences)


def test_research_summary_ignores_stored_scores(tmp_path: Path) -> None:
    data = research_data()
    data["scores"][0]["citation"]["pass"] = False
    loaded = read_run(write_run(tmp_path / "scores", data))
    assert recompute(loaded)["citation"]["answerPassRate"]["rate"] == 1


def test_markers_url_limitation_and_refusal() -> None:
    assert extract_citation_markers("A [1，2、3-5] [0] [2026] [１] [9-40]") == [1, 2, 3, 4, 5]
    assert extract_urls("https://EXAMPLE.test:443/a/#top（說明）https://example.test/a") == [
        "https://example.test/a"
    ]
    assert normalize_url("https://EXAMPLE.test:443/a/../b/#fragment") == "https://example.test/b"
    assert normalize_url("https://例子.test/中文") == "https://xn--fsqu00a.test/%E4%B8%AD%E6%96%87"
    assert normalize_url("not a url") == "not a url"
    assert states_limitation("No usable sources were found")
    assert states_limitation("目前無法取得資料")
    assert not states_limitation("A normal answer")
    obs = research_observation(category="no_source", sources=[], answer="無法取得資料。")
    assert score_case(obs).refusal.pass_
    assert not score_case(obs.model_copy(update={"answer": "無法取得資料 [1]"})).refusal.pass_
    assert score_citations("Fact [9]", obs.sources).unresolved == ["[9]"]
    assert score_citations("No citation", []).pass_ is None


def test_failed_timeout_null_empty_mode_and_rerank_denominators() -> None:
    completed = research_observation(
        answerMode="",
        rerank={
            "ok": False,
            "latencyMs": 3,
            "candidates": 2,
            "selected": 0,
            "changedSelections": 1,
        },
    )
    failed = research_observation(
        caseId="failed", category="no_source", status="failed", sources=[], answer="No results"
    )
    timeout = research_observation(
        caseId="timeout", category="clarify", status="timeout", answerMode="clarify"
    )
    observations = [completed, failed, timeout]
    summary = summarize_run(observations, [score_case(o) for o in observations])
    assert summary["cases"] == 3 and summary["completed"] == 1 and summary["failedOrTimeout"] == 2
    assert summary["routing"] == {"answerable:": 1}  # TS ?? preserves empty strings
    assert summary["refusal"]["n"] == 1 and summary["refusal"]["passed"] == 0
    assert summary["clarify"]["n"] == 1 and summary["clarify"]["passed"] == 0
    assert summary["rerank"]["casesWithChangedSelection"] == {"passed": 1, "n": 0, "rate": None}
