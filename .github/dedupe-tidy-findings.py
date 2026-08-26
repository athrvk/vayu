#!/usr/bin/env python3
"""Deduplicate a clang-tidy log into the finding list a measurement counts.

A whole-tree scan reports a header's finding once per translation unit that
includes it, so the raw line count is not a count of anything - it is what made
one #928 wave read 11 `concurrency-mt-unsafe` where 8 sites existed. The unit
here is therefore (file, line, column, check), the deduplication key
`docs/engine/building.md` names, and paths are normalised to repository-relative
POSIX form so a Windows run and a Linux run of the same tree are comparable.

Reads a clang-tidy log on stdin or from a path, writes a Markdown report on
stdout, and exits 1 if anything survived - so the caller is a gate as well as a
measurement.
"""

import argparse
import collections
import pathlib
import re
import sys

# `path:line:col: warning: text [check-name]`. clang-tidy also emits `error:`
# for a `clang-diagnostic-*` under WarningsAsErrors and for a genuine parse
# failure; both are findings a scan must count, not skip.
FINDING = re.compile(
    r"^(?P<file>[^:]*[^:\s][^:]*):(?P<line>\d+):(?P<col>\d+): "
    r"(?:warning|error): (?P<text>.*?) \[(?P<check>[\w.-]+(?:,[\w.-]+)*)\]\s*$"
)


def repo_relative(path: str, root: pathlib.PurePath) -> str:
    """`path` under `root`, as a POSIX path; unchanged if it is outside."""
    normalised = pathlib.PurePath(path.replace("\\", "/")).as_posix()
    root_posix = pathlib.PurePath(str(root).replace("\\", "/")).as_posix()
    prefix = root_posix.rstrip("/") + "/"
    if normalised.startswith(prefix):
        return normalised[len(prefix) :]
    return normalised


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", help="clang-tidy log (default: stdin)")
    parser.add_argument(
        "--root", required=True, help="repository root, to relativise paths against"
    )
    parser.add_argument(
        "--scanned",
        type=int,
        required=True,
        help="translation units handed to clang-tidy - the denominator",
    )
    parser.add_argument("--label", required=True, help="what this scan measured")
    args = parser.parse_args()

    text = (
        pathlib.Path(args.log).read_text(encoding="utf-8", errors="replace")
        if args.log
        else sys.stdin.read()
    )

    # A scan that read nothing must not report a clean tree - the discipline
    # every source-scanning guard in this repository owes.
    if not text.strip():
        print(f"::error::{args.label}: the clang-tidy log is empty, so nothing was scanned")
        return 1
    if args.scanned <= 0:
        print(f"::error::{args.label}: no translation units were handed to clang-tidy")
        return 1

    root = pathlib.PurePath(args.root)
    findings = {}
    for line in text.splitlines():
        match = FINDING.match(line)
        if not match:
            continue
        # An alias reports under both names on one line; the first is canonical.
        check = match.group("check").split(",")[0]
        key = (
            repo_relative(match.group("file"), root),
            int(match.group("line")),
            int(match.group("col")),
            check,
        )
        findings.setdefault(key, match.group("text"))

    print(f"## {args.label}")
    print()
    print(
        f"**{len(findings)}** findings, deduplicated by (file, line, column, check), "
        f"over **{args.scanned}** translation units."
    )
    print()

    if not findings:
        print("Zero findings.")
        return 0

    by_check = collections.Counter(key[3] for key in findings)
    print("| Check | Findings |")
    print("|-------|----------|")
    for check, count in by_check.most_common():
        print(f"| `{check}` | {count} |")
    print()
    print("| File | Line:Col | Check | Message |")
    print("|------|----------|-------|---------|")
    for (file, line, col, check), message in sorted(findings.items()):
        print(f"| `{file}` | {line}:{col} | `{check}` | {message} |")
    return 1


if __name__ == "__main__":
    sys.exit(main())
