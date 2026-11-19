"""Read only explicitly selected run files/directories. No repository-wide discovery."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from .models import KBRun, Provenance, ResearchRun


class InputError(ValueError):
    """Invalid local input, with filename and field path in its message."""


def safe_path(path: Path) -> Path:
    resolved = path.resolve()
    if any(part.startswith(".env") for part in (*path.parts, *resolved.parts)):
        raise InputError(f"{path}: environment files are not inputs or outputs")
    return resolved


def validation_message(path: Path, error: ValidationError) -> str:
    return "\n".join(
        f"{path}: {'.'.join(str(p) for p in item['loc']) or '<root>'}: {item['msg']}"
        for item in error.errors(include_input=False, include_url=False)
    )


@dataclass(frozen=True)
class LoadedRun:
    path: Path
    provenance_path: Path
    kind: Literal["kb", "research"]
    run: KBRun | ResearchRun
    provenance: Provenance

    @property
    def name(self) -> str:
        return f"{self.path.parent.name}/{self.path.name}"

    @property
    def versions(self) -> tuple[str, str | None]:
        return (
            self.provenance.datasetVersion,
            self.provenance.corpusVersion if self.kind == "kb" else None,
        )


def read_run(path: Path) -> LoadedRun:
    path = safe_path(path)
    provenance_path = safe_path(path.parent / "provenance.json")
    try:
        raw = path.read_text(encoding="utf-8")
        shape = json.loads(raw)
        if not isinstance(shape, dict):
            raise InputError(f"{path}: <root>: expected an object")
        try:
            if "strategy" in shape:
                run: KBRun | ResearchRun = KBRun.model_validate_json(raw)
                kind: Literal["kb", "research"] = "kb"
            elif "runnerVersion" in shape:
                run = ResearchRun.model_validate_json(raw)
                kind = "research"
            else:
                raise InputError(f"{path}: <root>: missing strategy or runnerVersion")
        except ValidationError as error:
            raise InputError(validation_message(path, error)) from error
        try:
            provenance = Provenance.model_validate_json(provenance_path.read_text(encoding="utf-8"))
        except ValidationError as error:
            raise InputError(validation_message(provenance_path, error)) from error
        if kind == "kb" and provenance.corpusVersion is None:
            raise InputError(f"{provenance_path}: corpusVersion: required for kb runs")
        if run.datasetVersion is not None and run.datasetVersion != provenance.datasetVersion:
            raise InputError(f"{path}: datasetVersion: differs from {provenance_path}")
        return LoadedRun(path, provenance_path, kind, run, provenance)
    except (OSError, json.JSONDecodeError) as error:
        raise InputError(f"{path}: <root>: {error}") from error


def discover(paths: list[Path]) -> list[Path]:
    """Only run-*.json in each selected directory or its immediate run directories."""
    found: list[Path] = []
    for path in paths:
        path = safe_path(path)
        if path.is_file():
            found.append(path)
        elif path.is_dir():
            found.extend(sorted(path.glob("run-*.json")))
            found.extend(sorted(path.glob("*/run-*.json")))
        else:
            raise InputError(f"{path}: path does not exist")
    result = list(dict.fromkeys(safe_path(path) for path in found))
    if not result:
        raise InputError("No run-*.json found in the specified paths")
    return result
