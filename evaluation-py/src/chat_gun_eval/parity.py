"""All-leaf comparison with absolute ratio tolerance and fingerprint-bound legacy exceptions."""

import hashlib
from dataclasses import dataclass
from pathlib import Path

from pydantic import JsonValue

from . import kb, research
from .models import InputModel, JsonObject, KBRun, json_object
from .reader import InputError, LoadedRun

RATIO_TOLERANCE = 1e-9
RATIO_LEAVES = frozenset(
    {
        "recallAt5",
        "mrr",
        "citationAccuracy",
        "faithfulness",
        "abstentionAccuracy",
        "falseAbstentionRate",
        "rate",
    }
)


class LegacyException(InputModel):
    run: str
    sha256: str
    reason: str
    missingPythonPaths: list[str]


class ExceptionManifest(InputModel):
    schemaVersion: str
    entries: list[LegacyException]


def exceptions() -> list[LegacyException]:
    path = Path(__file__).with_name("exceptions.json")
    data = ExceptionManifest.model_validate_json(path.read_text(encoding="utf-8"))
    if data.schemaVersion != "parity-exceptions@1":
        raise InputError(f"{path}: schemaVersion: unsupported exception manifest")
    if len({entry.run for entry in data.entries}) != len(data.entries):
        raise InputError(f"{path}: duplicate exception name")
    if any(not e.reason or not e.missingPythonPaths for e in data.entries):
        raise InputError(f"{path}: exception requires a reason and narrow paths")
    return data.entries


def recompute(loaded: LoadedRun) -> JsonObject:
    if isinstance(loaded.run, KBRun):
        return kb.rescore(loaded.run)
    return research.rescore(loaded.run)


def recorded(loaded: LoadedRun) -> JsonObject:
    if isinstance(loaded.run, KBRun):
        return json_object(loaded.run.summary.model_dump(mode="json", exclude_unset=True))
    return json_object(loaded.run.summary.model_dump(mode="json", exclude_unset=True))


def differences(expected: JsonValue, actual: JsonValue, prefix: str = "") -> list[str]:
    """Missing is distinct from null; counters/percentiles exact, ratios absolute 1e-9."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        diff: list[str] = []
        for key in sorted(expected.keys() | actual.keys()):
            location = f"{prefix}.{key}" if prefix else key
            if key not in expected:
                diff.append(f"{location}: TS=<missing> Python={actual[key]!r}")
            elif key not in actual:
                diff.append(f"{location}: TS={expected[key]!r} Python=<missing>")
            else:
                diff.extend(differences(expected[key], actual[key], location))
        return diff
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        return [
            d
            for i, (e, a) in enumerate(zip(expected, actual, strict=True))
            for d in differences(e, a, f"{prefix}[{i}]")
        ]
    if (
        isinstance(expected, (int, float))
        and not isinstance(expected, bool)
        and isinstance(actual, (int, float))
        and not isinstance(actual, bool)
    ):
        if prefix.rsplit(".", 1)[-1] in RATIO_LEAVES:
            same = abs(expected - actual) <= RATIO_TOLERANCE
        else:
            same = expected == actual
    else:
        same = type(expected) is type(actual) and expected == actual
    return [] if same else [f"{prefix}: TS={expected!r} Python={actual!r}"]


@dataclass(frozen=True)
class ParityResult:
    differences: list[str]
    legacy_omissions: tuple[str, ...] = ()


def check(loaded: LoadedRun) -> ParityResult:
    expected, actual = recorded(loaded), recompute(loaded)
    applicable = next(
        (e for e in exceptions() if e.run == loaded.name and loaded.kind == "kb"), None
    )
    omissions: list[str] = []
    if applicable:
        if hashlib.sha256(loaded.path.read_bytes()).hexdigest() != applicable.sha256:
            return ParityResult(
                [
                    "legacy exception fingerprint differs; refusal to exempt modified input",
                    *differences(expected, actual),
                ]
            )
        for location in applicable.missingPythonPaths:
            split, key = location.split(".", 1)
            expected_split, actual_split = expected.get(split), actual.get(split)
            if not isinstance(expected_split, dict) or not isinstance(actual_split, dict):
                raise InputError(f"{loaded.path}: invalid legacy exception split {split}")
            if key in expected_split or key not in actual_split:
                raise InputError(
                    f"{loaded.path}: legacy exception no longer applicable: {location}"
                )
            del actual_split[key]
            omissions.append(location)
    return ParityResult(differences(expected, actual), tuple(omissions))
