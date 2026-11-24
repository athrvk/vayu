#!/usr/bin/env python3
"""
Holds the comments in non-test source to the present tense, with per-file
ceilings that only go down (#3868, the source-code counterpart of docs-lint.py).

Counted, per file, are the comment lines that narrate what was instead of what
is: `used to`, `until #N`, `since #N`, `#N changed|moved|added|removed|replaced|
renamed|introduced|fixed|landed|shipped|merged`, `formerly` and `previously`.
A line holding two phrases counts once. `used to` after a form of "be" or "get"
is the passive ("is used to build"), not history, so it is not counted.

Not counted: `was renamed|moved|removed|replaced`, `before #N`, `pre-#N`,
`no longer` and `now`. They name a real constraint as often as a history, and
counting them would reward deleting the constraint.

A comment line is one whose first non-blank characters are `//`, `/*`, `*` or
`{/*`, or any line inside a block comment that such a line opened. A trailing
comment (code, then `// ...`) is not scanned: finding it takes a tokenizer, and
the line-start rule is what the ceilings were seeded with. There is no inline
allow-marker; a file with a legitimate use takes a ceiling entry instead.

Scope: the tracked `.cpp .hpp .h .ts .tsx .mjs .cjs` files under
`engine/include`, `engine/src`, `app/src` and `app/electron`, minus tests and
fixtures (`*.test.*`, `*.testkit.*`, `__fixtures__`, `app/src/test/`). Comments
in test files are a separate decision.

A file over zero has an entry in scripts/comment-lint-ceilings.json holding the
count it had when the entry was written, and is held to that; a file at zero has
none. The file may only shrink: an entry whose file now has no phrase left (or
is gone) fails as stale, and with --baseline an entry that is new or higher than
the baseline's fails. A split or rename is the one way an entry may be new: the
files that replace a retired entry may together hold what it held, and no more.

Usage: comment-lint.py [--root DIR] [--baseline FILE] [--measure]

  --root DIR       the repository root (default: the parent of scripts/)
  --baseline FILE  a ceilings file from the base branch; any entry above it fails
  --measure        print the ceilings file the current tree would need and exit,
                   for seeding it or lowering it by hand

Exits 0 when clean, 1 on findings, 2 on a malformed ceilings file or a scan that
found no files. Prints nothing on success.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOTS = ("engine/include", "engine/src", "app/src", "app/electron")
EXTENSIONS = (".cpp", ".hpp", ".h", ".ts", ".tsx", ".mjs", ".cjs")
CEILINGS_FILE = "comment-lint-ceilings.json"

_BE_OR_GET = ("is", "are", "be", "been", "being", "was", "were", "get", "gets", "got")
_HISTORY = (
    re.compile(
        "".join(f"(?<!\\b{word} )" for word in _BE_OR_GET) + r"\bused to\b",
        re.IGNORECASE,
    ),
    re.compile(r"\buntil #\d+", re.IGNORECASE),
    re.compile(r"\bsince #\d+", re.IGNORECASE),
    re.compile(
        r"#\d+ (?:changed|moved|added|removed|replaced|renamed|introduced|fixed"
        r"|landed|shipped|merged)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bformerly\b", re.IGNORECASE),
    re.compile(r"\bpreviously\b", re.IGNORECASE),
)
_COMMENT_START = ("//", "/*", "*", "{/*")
_BLOCK_OPENERS = ("/*", "{/*")
_EXAMPLES_SHOWN = 5


def in_scope(path: str) -> bool:
    """Whether a repo-relative POSIX path is non-test source this lint reads."""
    if not path.startswith(tuple(f"{root}/" for root in ROOTS)):
        return False
    parts = path.split("/")
    name = parts[-1]
    if not name.endswith(EXTENSIONS):
        return False
    if "__fixtures__" in parts or path.startswith("app/src/test/"):
        return False
    return ".test." not in name and ".testkit." not in name


def history_lines(text: str) -> list[tuple[int, str]]:
    """The comment lines of `text` that narrate history, as (line number, line)."""
    found = []
    in_block = False
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        is_comment = in_block or stripped.startswith(_COMMENT_START)
        if in_block:
            in_block = "*/" not in line
        elif stripped.startswith(_BLOCK_OPENERS):
            in_block = line.rfind("/*") > line.rfind("*/")
        if is_comment and any(pattern.search(line) for pattern in _HISTORY):
            found.append((number, line.strip()))
    return found


class CeilingsError(ValueError):
    pass


def parse_ceilings(raw: str, source: str) -> dict:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CeilingsError(f"{source}: not JSON: {error}") from None
    if not isinstance(data, dict) or set(data) != {"files"}:
        raise CeilingsError(f"{source}: expected exactly the key files")
    files = data["files"]
    if not isinstance(files, dict):
        raise CeilingsError(f"{source}: files must be an object")
    for path, value in files.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise CeilingsError(f"{source}: {path}: the ceiling must be a whole number")
    return data


def tracked_files(root: Path) -> list[str]:
    """Repo-relative POSIX paths git tracks or would track (untracked, not ignored)."""
    result = subprocess.run(
        ["git", "-C", str(root), "-c", "core.quotepath=off", "ls-files", "-z",
         "--cached", "--others", "--exclude-standard"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise CeilingsError(f"git ls-files failed in {root}: {result.stderr.decode().strip()}")
    return sorted({name.decode() for name in result.stdout.split(b"\0") if name})


def scan(root: Path) -> dict[str, list[tuple[int, str]]]:
    """Every in-scope file's history lines, files with none included."""
    scanned = {}
    for path in tracked_files(root):
        file = root / path
        if in_scope(path) and file.is_file():
            scanned[path] = history_lines(file.read_text(encoding="utf-8", errors="replace"))
    if not scanned:
        raise CeilingsError(f"no source files found under {root}: the root is wrong")
    return scanned


def file_findings(path: str, count: int, ceiling: int | None) -> list[str]:
    if ceiling is None and count > 0:
        return [f"{count} history comment line(s) and no ceiling: state what is, not what was"]
    if ceiling is not None and count > ceiling:
        return [f"{count} history comment line(s), over this file's ceiling of {ceiling}"]
    if ceiling is not None and count == 0:
        return ["stale ceiling: no history phrase is left, delete the entry"]
    return []


def stale_entries(scanned: dict, ceilings: dict) -> list[tuple[str, str]]:
    gone = "has a ceiling but is not a scanned file (gone, renamed or out of scope), delete it"
    return [
        (path, gone)
        for path in ceilings["files"]
        if path not in scanned
    ]


def new_entries(ceilings: dict, baseline: dict) -> list[tuple[str, str]]:
    """Entries for files the baseline has none for: only a split or rename may add them.

    The entries a change retires (in the baseline, not in the ceilings now) hand
    their counts on: the new entries may together hold what the retired ones
    held, no more. With nothing retired a new file starts at zero.
    """
    fresh = {p: n for p, n in ceilings["files"].items() if p not in baseline["files"]}
    held = sum(n for p, n in baseline["files"].items() if p not in ceilings["files"])
    found = []
    running = 0
    for path, count in fresh.items():
        running += count
        if running > held:
            message = f"new ceilings total more than the {held} the retired entries held"
            found.append((path, message))
            break
    return found


def raised_entries(ceilings: dict, baseline: dict) -> list[tuple[str, str]]:
    found = new_entries(ceilings, baseline)
    for path, value in ceilings["files"].items():
        base = baseline["files"].get(path)
        if base is not None and value > base:
            found.append((path, f"ceiling raised from {base} to {value}"))
    return found


def seed(scanned: dict) -> dict:
    return {
        "files": {path: len(lines) for path, lines in sorted(scanned.items()) if lines}
    }


def dump(ceilings: dict) -> str:
    return json.dumps(ceilings, indent=2) + "\n"


def lint(root: Path, baseline: dict | None) -> list[str]:
    ceilings_path = root / "scripts" / CEILINGS_FILE
    ceilings = parse_ceilings(ceilings_path.read_text(encoding="utf-8"), ceilings_path.name)
    scanned = scan(root)

    problems: list[tuple[str, str]] = []
    for path, lines in scanned.items():
        for finding in file_findings(path, len(lines), ceilings["files"].get(path)):
            problems.append((path, finding))
    problems += stale_entries(scanned, ceilings)
    if baseline is not None:
        problems += raised_entries(ceilings, baseline)

    report = [f"{path}: {finding}" for path, finding in problems]
    for path in dict.fromkeys(path for path, _ in problems):
        for number, text in scanned.get(path, [])[:_EXAMPLES_SHOWN]:
            report.append(f"  {path}:{number}: {text}")
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--measure", action="store_true")
    args = parser.parse_args(argv)

    try:
        baseline = None
        if args.baseline:
            baseline = parse_ceilings(args.baseline.read_text(encoding="utf-8"), "baseline")
        if args.measure:
            sys.stdout.write(dump(seed(scan(args.root))))
            return 0
        report = lint(args.root, baseline)
    except (CeilingsError, OSError) as error:
        print(f"comment-lint: {error}", file=sys.stderr)
        return 2

    if not report:
        return 0
    print("\n".join(report))
    print(
        f"\ncomment-lint: {sum(not line.startswith('  ') for line in report)} finding(s). "
        "Patterns and the ceilings file: scripts/comment-lint.py, CLAUDE.md (Comments)."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
