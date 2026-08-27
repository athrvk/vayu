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
#
# The `(?:[A-Za-z]:)?` is the Windows drive letter, and leaving it out is how
# this scan reported `0 findings over 206 translation units` for a log holding
# 679 of them: every path on that leg is `D:\a\vayu\...`, the colon after the
# drive is indistinguishable from the colon before the line number, and a file
# group that forbids colons matches none of them. Linux paths have no drive
# prefix, so the same regex read that leg correctly - which is exactly why the
# defect could sit here unseen.
LOCATED = re.compile(
    r"^(?P<file>(?:[A-Za-z]:)?[^:]*[^:\s][^:]*):(?P<line>\d+):(?P<col>\d+): "
    r"(?:warning|error): (?P<text>.*?) \[(?P<check>[\w.-]+(?:,[\w.-]+)*)\]\s*$"
)

# Deliberately loose: any line that *looks* like a diagnostic, whether or not
# the structured patterns above can read it. This is not used to count
# findings - it is used to catch the parser having failed, which is the one
# failure mode a report cannot describe about itself. Twice now this script has
# answered "zero" for a log full of diagnostics, both times because a real
# diagnostic took a shape a regex did not anticipate; a shape nobody
# anticipated is precisely what the next one will be too, so the guard asks
# the question structurally instead of enumerating forms.
DIAGNOSTIC_SHAPED = re.compile(r"(?:^|[:\s])(?:warning|error): ")

# The same diagnostic with **no location at all** - `error: no such file or
# directory: '...' [clang-diagnostic-error]`. A driver failure is reported this
# way, and matching only the located form is how a scan in which every
# translation unit failed to parse read as a clean tree: 206 units, 821 lines of
# error, zero findings counted. These carry no (file, line, column) to
# deduplicate on, so they are keyed by their own text.
UNLOCATED = re.compile(
    r"^(?:warning|error): (?P<text>.*?) \[(?P<check>[\w.-]+(?:,[\w.-]+)*)\]\s*$"
)

# clang-tidy's own line for a translation unit it could not finish. A unit that
# did not lint is not a unit that linted clean, so this fails the scan
# separately from the finding count - the denominator has to be units actually
# read, and this is the only line that says one was not.
NOT_PROCESSED = re.compile(r"^Error while processing ")


def repo_relative(path: str, root: pathlib.PurePath) -> str | None:
    """`path` under `root`, as a POSIX path; None if it is outside the tree.

    A finding in a file this repository does not contain is not this
    repository's finding, and counting one is how a scan reports a defect
    nobody can fix and no `NOLINT` can reach. `clang-analyzer-*` diagnostics
    are why this is not hypothetical: they do not honour `-header-filter`, so
    a walk that inlines into the platform's standard library reports there -
    `C:/Program Files/.../xfilesystem_abi.h` in the run that prompted this.
    Such a finding is still worth *seeing*, so the caller counts what was
    dropped and prints it rather than discarding it silently.
    """
    normalised = pathlib.PurePath(path.replace("\\", "/")).as_posix()
    root_posix = pathlib.PurePath(str(root).replace("\\", "/")).as_posix()
    prefix = root_posix.rstrip("/") + "/"
    if normalised.startswith(prefix):
        return normalised[len(prefix) :]
    return None


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
    outside = {}
    unfinished = 0
    diagnostic_shaped = 0
    unreadable = []
    for line in text.splitlines():
        line = line.rstrip("\r")
        if NOT_PROCESSED.match(line):
            unfinished += 1
            continue
        if DIAGNOSTIC_SHAPED.search(line):
            diagnostic_shaped += 1
        match = LOCATED.match(line)
        if match:
            # An alias reports under both names on one line; the first is
            # canonical.
            check = match.group("check").split(",")[0]
            relative = repo_relative(match.group("file"), root)
            if relative is None:
                outside.setdefault(
                    (match.group("file"), match.group("line"), check),
                    match.group("text"),
                )
                continue
            key = (
                relative,
                int(match.group("line")),
                int(match.group("col")),
                check,
            )
            findings.setdefault(key, match.group("text"))
            continue
        match = UNLOCATED.match(line)
        if match:
            check = match.group("check").split(",")[0]
            key = ("(no location)", 0, 0, check + ": " + match.group("text"))
            findings.setdefault(key, match.group("text"))
            continue
        if DIAGNOSTIC_SHAPED.search(line):
            unreadable.append(line)

    print(f"## {args.label}")
    print()
    print(
        f"**{len(findings)}** findings, deduplicated by (file, line, column, check), "
        f"over **{args.scanned}** translation units."
    )
    print()

    if outside:
        print(
            f"Ignored **{len(outside)}** finding(s) in files outside the repository "
            f"(`clang-analyzer-*` does not honour `-header-filter`). Not this tree's "
            f"to fix, and listed so the exclusion is visible rather than assumed:"
        )
        print()
        for (file, line, check), message in sorted(outside.items()):
            print(f"- `{file}:{line}` `{check}` - {message}")
        print()

    if unfinished:
        print(
            f"::error::{unfinished} translation unit(s) clang-tidy could not finish "
            f"(`Error while processing`). A unit that did not lint is not a unit that "
            f"linted clean, so this scan measured nothing it can be trusted on."
        )
        print()

    # `outside` counts as parsed: the guard asks whether the patterns could READ
    # the log, not whether what they read was this tree's. Without that, a log
    # whose every finding sits in a system header would parse perfectly and be
    # reported as a broken parser.
    if not findings and not outside and diagnostic_shaped:
        print(
            f"::error::{args.label}: the log holds {diagnostic_shaped} diagnostic-shaped "
            f"line(s) and this script parsed none of them into a finding. That is a "
            f"defect in this script, not a clean tree - a zero it produced here would "
            f"be the false green it exists to prevent. Fix the pattern before trusting "
            f"any number from this scan."
        )
        print()
        print("First few lines it could not read:")
        for line in unreadable[:5]:
            print(f"    {line}")
        return 1

    if not findings and not unfinished:
        print("Zero findings.")
        return 0
    if not findings:
        return 1

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
