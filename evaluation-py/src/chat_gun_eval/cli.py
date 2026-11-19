"""Offline local-file CLI. Installation may use uv; execution never needs a network."""

import argparse
import sys
from pathlib import Path

from .parity import check
from .reader import InputError, discover, read_run
from .report import atomic_write, compare


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chat-gun-eval")
    commands = parser.add_subparsers(dest="command", required=True)
    parity = commands.add_parser("parity", help="Recompute every summary leaf in selected runs")
    parity.add_argument("paths", type=Path, nargs="+")
    comparison = commands.add_parser("compare", help="Compare two or more selected runs")
    comparison.add_argument("paths", type=Path, nargs="+")
    comparison.add_argument("--allow-cross-version", action="store_true")
    comparison.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        runs = [read_run(p) for p in discover(args.paths)]
        if args.command == "compare":
            report = compare(runs, allow_cross_version=args.allow_cross_version)
            atomic_write(
                args.output, report, [p for r in runs for p in (r.path, r.provenance_path)]
            )
            print(f"Wrote {args.output}")
            return 0
        failed = 0
        for run in runs:
            result = check(run)
            if result.differences:
                failed += 1
                for difference in result.differences:
                    print(f"{run.kind} {run.path}: {difference}", file=sys.stderr)
            else:
                suffix = (
                    f" (named legacy exception: {len(result.legacy_omissions)} absent subtrees)"
                    if result.legacy_omissions
                    else ""
                )
                print(f"PASS {run.kind} {run.name}{suffix}")
        print(f"parity: {len(runs) - failed} passed, {failed} failed, {len(runs)} runs")
        return 1 if failed else 0
    except (InputError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Interrupted; no partial output report retained", file=sys.stderr)
        return 130
