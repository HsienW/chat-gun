import ast
import hashlib
import json
import socket
import tomllib
from pathlib import Path

import pytest
import yaml
from conftest import REPO, kb_data, research_data, write_run

from chat_gun_eval.cli import main
from chat_gun_eval.reader import InputError, discover, read_run
from chat_gun_eval.report import atomic_write, compare, sample_size


def test_compare_determinism_privacy_and_samples(kb_file: Path, tmp_path: Path) -> None:
    second = write_run(tmp_path / "second", kb_data())
    provenance_file = second.parent / "provenance.json"
    provenance = json.loads(provenance_file.read_text(encoding="utf-8"))
    provenance["generationModel"] = "fixture-model-B"
    provenance_file.write_text(json.dumps(provenance), encoding="utf-8")
    runs = [read_run(kb_file), read_run(second)]
    before = [
        (p, hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
        for r in runs
        for p in (r.path, r.provenance_path)
    ]
    report = compare(runs)
    assert report == compare(runs)
    assert "generationModel | fixture-model | fixture-model-B" in report
    assert "PRIVATE_QUESTION_SENTINEL" not in report
    assert "PRIVATE_ANSWER_SENTINEL" not in report
    assert "PRIVATE_EVIDENCE_SENTINEL" not in report
    assert "generationThinkingEnabled | 未記錄 | 未記錄" in report
    assert "generationEndpointHost | 未記錄 | 未記錄" in report
    assert "小樣本，一兩題的差異應視為雜訊" in report
    assert "| test.mrr | run 1 | 1.000000000 | +0.000000000 | 1 |" in report
    assert sample_size(runs[0], "test.faithfulness") == 1
    assert sample_size(runs[0], "dev.faithfulness") == 0
    assert sample_size(runs[0], "test.retrievalP50Ms") == 0
    assert all(
        hashlib.sha256(p.read_bytes()).hexdigest() == sha and p.stat().st_mtime_ns == time
        for p, sha, time in before
    )


def test_version_kind_and_count_gate_preserve_existing_output(
    kb_file: Path, tmp_path: Path, capsys
) -> None:
    second = write_run(tmp_path / "second", kb_data(), version="other-v1")
    target = tmp_path / "report.md"
    target.write_text("original", encoding="utf-8")
    assert main(["compare", str(kb_file), "--output", str(target)]) == 2
    assert "at least two" in capsys.readouterr().err
    assert main(["compare", str(kb_file), str(second), "--output", str(target)]) == 2
    assert target.read_text(encoding="utf-8") == "original"
    assert (
        main(
            ["compare", str(kb_file), str(second), "--allow-cross-version", "--output", str(target)]
        )
        == 0
    )
    assert "跨資料集版本" in target.read_text(encoding="utf-8")
    research = write_run(tmp_path / "research", research_data())
    with pytest.raises(InputError, match="same evaluation type"):
        compare([read_run(kb_file), read_run(research)])
    p = second.parent / "provenance.json"
    provenance = json.loads(p.read_text(encoding="utf-8"))
    provenance.update(datasetVersion="fixture-v1", corpusVersion="other-corpus")
    p.write_text(json.dumps(provenance), encoding="utf-8")
    with pytest.raises(InputError, match="corpusVersion"):
        compare([read_run(kb_file), read_run(second)])


def test_research_report_all_leaves_and_denominators(tmp_path: Path) -> None:
    first = write_run(tmp_path / "a", research_data())
    second = write_run(
        tmp_path / "b",
        research_data(citationGuard={"modified": True, "removedMarkers": 3, "removedUrls": 1}),
    )
    report = compare([read_run(first), read_run(second)])
    assert "citationGuard.answersModified.rate" in report
    assert "未記錄" in report
    assert sample_size(read_run(first), "citation.answerPassRate.rate") == 1
    assert sample_size(read_run(first), "latency.answerable.p90Ms") == 1
    assert sample_size(read_run(second), "citationGuard.removedUrls") == 1


@pytest.mark.parametrize("interruption_point", ["replace", "fsync"])
def test_interrupt_never_leaves_partial_report(
    tmp_path: Path, monkeypatch, interruption_point: str
) -> None:
    output = tmp_path / "report.md"
    output.write_bytes(b"original")

    def interrupt(*args: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("chat_gun_eval.report.os." + interruption_point, interrupt)
    with pytest.raises(KeyboardInterrupt):
        atomic_write(output, "new report")
    assert output.read_bytes() == b"original"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["report.md"]


def test_cli_keyboard_interrupt_and_input_overwrite(
    kb_file: Path, tmp_path: Path, monkeypatch
) -> None:
    second = write_run(tmp_path / "second", kb_data())
    before = kb_file.read_bytes()
    assert main(["compare", str(kb_file), str(second), "--output", str(kb_file)]) == 2
    assert kb_file.read_bytes() == before

    def interrupt(*args: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("chat_gun_eval.report.os.replace", interrupt)
    assert main(["compare", str(kb_file), str(second), "--output", str(tmp_path / "new.md")]) == 130
    assert not (tmp_path / "new.md").exists()


def test_no_network_parity_and_compare(kb_file: Path, tmp_path: Path, monkeypatch) -> None:
    second = write_run(tmp_path / "second", kb_data())

    def blocked(*args: object, **kwargs: object) -> None:
        raise AssertionError("network is unavailable")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    assert main(["parity", str(kb_file), str(second)]) == 0
    target = tmp_path / "report.md"
    assert main(["compare", str(kb_file), str(second), "--output", str(target)]) == 0
    before = target.read_bytes()
    assert main(["compare", str(kb_file), str(second), "--output", str(target)]) == 0
    assert target.read_bytes() == before


def test_forbid_environment_files_before_open(tmp_path: Path) -> None:
    # The test never creates or opens an environment file; rejection happens before filesystem IO.
    with pytest.raises(InputError, match="environment files"):
        read_run(tmp_path / ".env")
    with pytest.raises(InputError, match="environment files"):
        atomic_write(tmp_path / ".env.production", "forbidden")


def test_discovery_is_limited_to_explicit_roots(tmp_path: Path) -> None:
    selected = tmp_path / "selected"
    file = write_run(selected / "one", kb_data())
    write_run(tmp_path / "other", kb_data())
    write_run(selected / "nested" / "too-deep", kb_data())
    assert discover([selected]) == [file.resolve()]
    empty = tmp_path / "other" / "empty"
    empty.mkdir()
    with pytest.raises(InputError, match="No run"):
        discover([empty])


def test_dependencies_and_imports_have_no_network_or_model_sdk() -> None:
    package = REPO / "evaluation-py"
    config = tomllib.loads((package / "pyproject.toml").read_text(encoding="utf-8"))
    assert config["project"]["dependencies"] == ["pydantic>=2.12,<3"]
    allowed = {
        "argparse",
        "collections",
        "dataclasses",
        "hashlib",
        "ipaddress",
        "json",
        "math",
        "os",
        "pathlib",
        "re",
        "sys",
        "tempfile",
        "typing",
        "pydantic",
    }
    for file in (package / "src/chat_gun_eval").glob("*.py"):
        for node in ast.walk(ast.parse(file.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                assert all(alias.name.split(".")[0] in allowed for alias in node.names)
            if isinstance(node, ast.ImportFrom) and node.level == 0:
                assert node.module == "urllib.parse" or node.module.split(".")[0] in allowed
    assert config["tool"]["mypy"]["strict"] is True
    assert config["project"]["requires-python"] == ">=3.12,<3.13"
    assert (package / "uv.lock").is_file()


def test_workflow_yaml_and_quality_gates() -> None:
    workflow = yaml.safe_load(
        (REPO / ".github/workflows/python-evaluation.yml").read_text(encoding="utf-8")
    )
    for trigger in ("push", "pull_request"):
        assert {
            "evaluation-py/**",
            "backend/data/knowledge-eval/results/**",
            "backend/data/research-eval/results/**",
        } <= set(workflow["on"][trigger]["paths"])
    job = workflow["jobs"]["evaluation"]
    commands = [step["run"] for step in job["steps"] if "run" in step]
    assert "uv sync --locked" in commands
    for gate in ["ruff format --check", "ruff check", "mypy", "pytest", "chat-gun-eval parity"]:
        assert any(gate in command for command in commands)
    assert all("continue-on-error" not in step for step in job["steps"])
    assert job["defaults"]["run"]["working-directory"] == "evaluation-py"


def test_example_is_reproducible_from_cli(tmp_path: Path) -> None:
    directory = REPO / "backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27-r2"
    first, second = directory / "run-vector_only.json", directory / "run-vector_rerank.json"
    target = tmp_path / "example.md"
    assert main(["compare", str(first), str(second), "--output", str(target)]) == 0
    assert target.read_bytes() == (REPO / "evaluation-py/examples/kb-comparison.md").read_bytes()
