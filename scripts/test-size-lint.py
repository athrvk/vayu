#!/usr/bin/env python3
"""
Holds test files to a line cap, with exceptions that only shrink (#3854, T5).

A test file past a few thousand lines is what put 22 conflicts on one MCP test
and made one C++ suite a 78-second clang-tidy unit. The cap is a number the
owner sets here, not one that follows the code:

  cap   1,500 lines per test file

A test file is `*.test.ts`, `*.test.tsx`, `*.testkit.ts`, `*.testkit.tsx` or
`*_test.cpp`, anywhere in the tracked tree outside `engine/vendor`.

A file over the cap has an entry in scripts/test-size-exceptions.json holding the
size it had when the entry was written, and is held to that instead. The file may
only shrink:

  - a file over the cap with no entry fails: split it, by suite or by source
    module, rather than list it;
  - a file over its recorded size fails;
  - an entry whose file is now within the cap (or gone) fails as stale;
  - with --baseline, an entry that is new or higher than the baseline's fails,
    so a pull request cannot raise an exception to make room.

A run that finds almost no test files fails too: a wrong root or a changed
pattern would otherwise pass forever.

Usage: test-size-lint.py [--root DIR] [--baseline FILE] [--measure]

  --root DIR       the repository root (default: the parent of scripts/)
  --baseline FILE  an exceptions file from the base branch; any entry that is
                   new or higher than the baseline's fails
  --measure        print the exceptions file the current tree would need and
                   exit, for seeding it or lowering it by hand

Exits 0 when clean, 1 on findings, 2 on a malformed exceptions file or a scan
that found too few test files. Prints nothing on success.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

LINE_CAP = 1500

# Fewer test files than this means the scan is broken, not that the suite shrank:
# the tree held 1,800 when the cap was set.
MIN_TEST_FILES = 1000

EXCEPTIONS_PATH = Path("scripts") / "test-size-exceptions.json"

_TEST_FILE = re.compile(r"(?:\.test\.tsx?|\.testkit\.tsx?|_test\.cpp)$")
_VENDORED = "engine/vendor/"


class ExceptionsError(ValueError):
    pass


def line_count(data: bytes) -> int:
    """Lines as `wc -l` counts them, plus a last line with no newline."""
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


def tracked_files(root: Path) -> list[str]:
    # Untracked files count: a new test file is measured before it is committed.
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=True,
        capture_output=True,
    ).stdout
    return [path for path in out.decode("utf-8").split("\0") if path]


def is_test_file(path: str) -> bool:
    return bool(_TEST_FILE.search(path)) and not path.startswith(_VENDORED)


def measure_tests(root: Path) -> dict[str, int]:
    sizes = {}
    for path in tracked_files(root):
        if not is_test_file(path):
            continue
        file = root / path
        if file.is_file():
            sizes[path] = line_count(file.read_bytes())
    return sizes


def parse_exceptions(raw: str, source: str) -> dict[str, int]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ExceptionsError(f"{source}: not JSON: {error}") from None
    if not isinstance(data, dict) or set(data) != {"files"} or not isinstance(data["files"], dict):
        raise ExceptionsError(f"{source}: expected exactly the key files, holding an object")
    for path, size in data["files"].items():
        if not isinstance(size, int) or isinstance(size, bool) or size <= LINE_CAP:
            raise ExceptionsError(
                f"{source}: {path}: the recorded size must be a whole number over the cap of {LINE_CAP}"
            )
    return data["files"]


def file_findings(sizes: dict[str, int], exceptions: dict[str, int]) -> list[tuple[str, str]]:
    found = []
    for path, size in sorted(sizes.items()):
        recorded = exceptions.get(path)
        if recorded is None and size > LINE_CAP:
            message = f"{size} lines, over the cap of {LINE_CAP}: split it by suite or by source module"
            found.append((path, f"{message}, do not list it"))
        elif recorded is not None and size > recorded:
            found.append(
                (path, f"{size} lines, over its recorded {recorded}: an exception only shrinks")
            )
        elif recorded is not None and size <= LINE_CAP:
            found.append(
                (path, f"stale exception: {size} lines is within the cap of {LINE_CAP}, delete the entry")
            )
    found += [
        (path, "has an exception but the file does not exist, delete the entry")
        for path in sorted(exceptions)
        if path not in sizes
    ]
    return found


def raised_entries(exceptions: dict[str, int], baseline: dict[str, int]) -> list[tuple[str, str]]:
    found = []
    for path, size in sorted(exceptions.items()):
        base = baseline.get(path)
        if base is None:
            found.append((path, "is a new exception: a file over the cap is split, not listed"))
        elif size > base:
            found.append((path, f"exception raised from {base} to {size}"))
    return found


def seed(sizes: dict[str, int]) -> dict:
    return {"files": {path: size for path, size in sorted(sizes.items()) if size > LINE_CAP}}


def dump(exceptions: dict) -> str:
    return json.dumps(exceptions, indent=2) + "\n"


def lint(root: Path, baseline: dict[str, int] | None) -> tuple[list[str], dict[str, int]]:
    exceptions_path = root / EXCEPTIONS_PATH
    exceptions = parse_exceptions(exceptions_path.read_text(encoding="utf-8"), exceptions_path.name)
    sizes = measure_tests(root)
    if len(sizes) < MIN_TEST_FILES:
        raise ExceptionsError(
            f"found {len(sizes)} test files under {root}, fewer than {MIN_TEST_FILES}: "
            "the root or the file pattern is wrong"
        )

    problems = file_findings(sizes, exceptions)
    if baseline is not None:
        problems += raised_entries(exceptions, baseline)
    return [f"{path}: {finding}" for path, finding in problems], sizes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--measure", action="store_true")
    args = parser.parse_args(argv)

    try:
        baseline = None
        if args.baseline:
            baseline = parse_exceptions(args.baseline.read_text(encoding="utf-8"), "baseline")
        if args.measure:
            sys.stdout.write(dump(seed(measure_tests(args.root))))
            return 0
        report, _ = lint(args.root, baseline)
    except (ExceptionsError, OSError, subprocess.CalledProcessError) as error:
        print(f"test-size-lint: {error}", file=sys.stderr)
        return 2

    if not report:
        return 0
    print("\n".join(report))
    print(
        f"\ntest-size-lint: {len(report)} finding(s). "
        "The cap and the exceptions file: scripts/test-size-lint.py, CONTRIBUTING.md."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
