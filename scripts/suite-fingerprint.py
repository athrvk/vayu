#!/usr/bin/env python3
"""
Fingerprints the inputs of a PR CI suite, so a run can reuse a pass of that
suite on identical inputs instead of running it again.

The inputs are the files the routing filters in `pr-tests.yml` name for the
suite, read from that file's `area` step rather than restated here, so the
routing and the fingerprint cannot disagree about what a suite reads. Only the
positive patterns count: ignoring the `!` exclusions makes the input set a
superset of what routing matches, which can only cost a reuse, never grant a
wrong one. The digest covers each matched file's mode, blob id and path in the
checked-out tree (the merge commit CI tests), the filter names, and this
script's own bytes, so a change to how inputs are read retires every earlier
fingerprint.

Usage: suite-fingerprint.py <workflow> <step-id> <filter> [<filter> ...]
Prints the hex digest; the matched-file count goes to stderr.
"""

import hashlib
import re
import subprocess
import sys
from pathlib import Path

_KEY = re.compile(r"([A-Za-z_][A-Za-z0-9_]*):")
_ITEM = re.compile(r"- '([^']+)'")


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def read_filters(workflow_text: str, step_id: str) -> dict[str, list[str]]:
    """The `filters: |` block of the step with `id: <step_id>`, as name -> patterns.

    The block is a YAML literal holding a mapping of string lists. It is read
    line by line: a key, a quoted list item, a comment or a blank line, and
    anything else is an error rather than a guess.
    """
    lines = workflow_text.splitlines()
    try:
        step = next(
            i for i, line in enumerate(lines) if line.strip().removeprefix("- ") == f"id: {step_id}"
        )
        start = next(i for i in range(step, len(lines)) if lines[i].strip() == "filters: |")
    except StopIteration:
        raise ValueError(f"no step with id '{step_id}' and a 'filters: |' block") from None
    base = _indent(lines[start])
    filters: dict[str, list[str]] = {}
    current = None
    for line in lines[start + 1 :]:
        text = line.strip()
        if not text:
            continue
        if _indent(line) <= base:
            break
        if text.startswith("#"):
            continue
        key = _KEY.fullmatch(text)
        if key:
            current = key.group(1)
            filters[current] = []
            continue
        item = _ITEM.fullmatch(text)
        if item and current is not None:
            filters[current].append(item.group(1))
            continue
        raise ValueError(f"unrecognised line in the filters block: {line!r}")
    return filters


def glob_regex(pattern: str) -> re.Pattern[str]:
    """picomatch's reading of the glob forms the filters use: `**`, `**/`, `*`."""
    if any(c in pattern for c in "{}[]()!?"):
        raise ValueError(f"pattern uses glob syntax this script does not read: {pattern!r}")
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def tree_entries(repo: Path) -> list[tuple[str, str, str]]:
    """(mode, object id, path) for every file in HEAD's tree."""
    raw = subprocess.run(
        ["git", "-C", str(repo), "ls-tree", "-r", "-z", "--full-tree", "HEAD"],
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    entries = []
    for record in raw.split("\0"):
        if not record:
            continue
        meta, path = record.split("\t", 1)
        mode, _kind, oid = meta.split(" ")
        entries.append((mode, oid, path))
    return entries


def fingerprint(workflow: Path, step_id: str, names: list[str], repo: Path) -> tuple[str, int]:
    filters = read_filters(workflow.read_text(encoding="utf-8"), step_id)
    patterns = []
    for name in names:
        if name not in filters:
            raise ValueError(f"no filter named '{name}' in step '{step_id}'")
        positive = [p for p in filters[name] if not p.startswith("!")]
        if not positive:
            raise ValueError(f"filter '{name}' has no positive pattern")
        patterns.extend(glob_regex(p) for p in positive)

    matched = sorted(e for e in tree_entries(repo) if any(p.match(e[2]) for p in patterns))
    if not matched:
        raise ValueError(f"filters {names} match no file in HEAD")

    digest = hashlib.sha256()
    digest.update(Path(__file__).read_bytes())
    digest.update(("\n".join(sorted(names)) + "\n").encode())
    for mode, oid, path in matched:
        digest.update(f"{mode} {oid} {path}\0".encode())
    return digest.hexdigest(), len(matched)


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 2
    workflow, step_id, names = Path(argv[1]), argv[2], argv[3:]
    try:
        value, count = fingerprint(workflow, step_id, names, Path.cwd())
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"suite-fingerprint: {error}", file=sys.stderr)
        return 1
    print(f"suite-fingerprint: {' '.join(names)}: {count} files", file=sys.stderr)
    print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
