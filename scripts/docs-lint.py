#!/usr/bin/env python3
"""
Holds the pages under docs/ to a size and shape budget, with per-page ceilings
that only go down (#3846).

Per page it measures:

  lines       lines in the file                      600 (1,000 for a reference page)
  max_line    longest line, in characters            400
  long_lines  lines over 400 characters              0
  max_cell    longest table cell, in characters      200
  history     phrases that narrate what was          0
  description a front-matter `description:`          required

A page over a budget has an entry in scripts/docs-lint-ceilings.json holding the
value it had when the entry was written, and is held to that instead. The file
may only shrink: an entry whose page is now within budget (or gone) fails as
stale, and with --baseline an entry that is new or higher than the baseline's
fails. The one new entry allowed is a page split out of one that is gone: it may
carry ceilings no higher than that removed page's, metric by metric. A page
without an entry meets the budget. A missing description is never
grandfathered.

A reference page is one matching a glob in the file's `reference_pages`.

`history` counts `used to`, `until #N`, `since #N landed|merged|shipped`,
`formerly`, `previously`, `was renamed|moved|removed|replaced`, and an issue
number in a heading. Fenced code is skipped. `used to` after a form of "be" or
"get" is the passive ("is used to build"), not history, so it is not counted.
Rationale stays allowed; only these narrating phrases are counted.

Usage: docs-lint.py [--root DIR] [--baseline FILE] [--measure]

  --root DIR       the repository root (default: the parent of scripts/)
  --baseline FILE  a ceilings file from the base branch; any entry or value above
                   it fails
  --measure        print the ceilings file the current tree would need and exit,
                   for seeding it or lowering it by hand

Exits 0 when clean, 1 on findings, 2 on a malformed ceilings file. Prints
nothing on success.
"""

import argparse
import fnmatch
import json
import re
import sys
from pathlib import Path

LINES_BUDGET = 600
LINES_BUDGET_REFERENCE = 1000
LINE_LENGTH_BUDGET = 400
CELL_LENGTH_BUDGET = 200

# The measured values a ceiling may hold, in the order they are reported. A
# missing description is not here: it is a plain failure, never an entry.
METRICS = ("lines", "max_line", "long_lines", "max_cell", "history")

_WHAT = {
    "lines": "lines",
    "max_line": "characters in the longest line",
    "long_lines": f"lines over {LINE_LENGTH_BUDGET} characters",
    "max_cell": "characters in the longest table cell",
    "history": "history phrases",
}

_FENCE = re.compile(r"\s*(`{3,}|~{3,})")
_DESCRIPTION = re.compile(r"description:[ \t]*\S")
_BE_OR_GET = ("is", "are", "be", "been", "being", "was", "were", "get", "gets", "got")
_HISTORY = (
    re.compile(
        "".join(f"(?<!\\b{word} )" for word in _BE_OR_GET) + r"\bused to\b",
        re.IGNORECASE,
    ),
    re.compile(r"\buntil #\d+", re.IGNORECASE),
    re.compile(r"\bsince #\d+ (?:landed|merged|shipped)\b", re.IGNORECASE),
    re.compile(r"\bformerly\b", re.IGNORECASE),
    re.compile(r"\bpreviously\b", re.IGNORECASE),
    re.compile(r"\bwas (?:renamed|moved|removed|replaced)\b", re.IGNORECASE),
)
_HEADING_WITH_ISSUE = re.compile(r"#{1,6} .*#\d+")


def table_cells(line: str) -> list[str]:
    """The cells of a table row: split on `|` outside a code span, not after `\\`."""
    cells = []
    start = 0
    i = 0
    while i < len(line):
        char = line[i]
        if char == "\\":
            i += 2
        elif char == "`":
            run = len(line[i:]) - len(line[i:].lstrip("`"))
            close = line.find("`" * run, i + run)
            i = i + run if close == -1 else close + run
        elif char == "|":
            cells.append(line[start:i])
            start = i + 1
            i += 1
        else:
            i += 1
    cells.append(line[start:])
    return cells


def has_description(lines: list[str]) -> bool:
    """Whether the front matter, if the file opens one, carries a `description:`."""
    if not lines or lines[0].strip() != "---":
        return False
    for line in lines[1:]:
        if line.strip() == "---":
            return False
        if _DESCRIPTION.match(line):
            return True
    return False


def count_history(line: str) -> int:
    heading = 1 if _HEADING_WITH_ISSUE.match(line) else 0
    return heading + sum(len(pattern.findall(line)) for pattern in _HISTORY)


def measure_page(text: str) -> dict:
    lines = [line.removesuffix("\r") for line in text.split("\n")]
    if lines and lines[-1] == "":
        lines.pop()

    max_cell = 0
    history = 0
    fence = None
    for line in lines:
        opener = _FENCE.match(line)
        if opener:
            marks = opener.group(1)
            if fence is None:
                fence = marks
            elif marks[0] == fence[0] and len(marks) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        history += count_history(line)
        if line.lstrip().startswith("|"):
            max_cell = max([max_cell, *(len(cell.strip()) for cell in table_cells(line))])

    return {
        "lines": len(lines),
        "max_line": max((len(line) for line in lines), default=0),
        "long_lines": sum(len(line) > LINE_LENGTH_BUDGET for line in lines),
        "max_cell": max_cell,
        "history": history,
        "description": has_description(lines),
    }


def budget(metric: str, reference: bool) -> int:
    return {
        "lines": LINES_BUDGET_REFERENCE if reference else LINES_BUDGET,
        "max_line": LINE_LENGTH_BUDGET,
        "long_lines": 0,
        "max_cell": CELL_LENGTH_BUDGET,
        "history": 0,
    }[metric]


class CeilingsError(ValueError):
    pass


def parse_ceilings(raw: str, source: str) -> dict:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CeilingsError(f"{source}: not JSON: {error}") from None
    if not isinstance(data, dict) or set(data) != {"reference_pages", "pages"}:
        raise CeilingsError(f"{source}: expected exactly the keys reference_pages and pages")
    globs, pages = data["reference_pages"], data["pages"]
    if not isinstance(globs, list) or not all(isinstance(g, str) for g in globs):
        raise CeilingsError(f"{source}: reference_pages must be a list of globs")
    if not isinstance(pages, dict):
        raise CeilingsError(f"{source}: pages must be an object")
    for page, entry in pages.items():
        if not isinstance(entry, dict) or not entry:
            raise CeilingsError(f"{source}: {page}: an entry holds at least one ceiling")
        for metric, value in entry.items():
            if metric not in METRICS:
                raise CeilingsError(f"{source}: {page}: unknown ceiling '{metric}'")
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise CeilingsError(f"{source}: {page}: '{metric}' must be a whole number")
    return data


def is_reference(page: str, ceilings: dict) -> bool:
    return any(fnmatch.fnmatchcase(page, glob) for glob in ceilings["reference_pages"])


def page_findings(page: str, measured: dict, entry: dict, reference: bool) -> list[str]:
    found = []
    if not measured["description"]:
        found.append("no front-matter `description:` (it is the page's meta and social-card text)")
    for metric in METRICS:
        value, limit = measured[metric], budget(metric, reference)
        ceiling = entry.get(metric)
        if ceiling is None and value > limit:
            found.append(f"{value} {_WHAT[metric]}, over the budget of {limit}")
        elif ceiling is not None and value > ceiling:
            found.append(f"{value} {_WHAT[metric]}, over this page's ceiling of {ceiling}")
        elif ceiling is not None and value <= limit:
            found.append(
                f"stale ceiling for {metric}: {value} is within the budget of {limit}, "
                "delete the entry"
            )
    return found


def stale_entries(pages: dict, ceilings: dict) -> list[tuple[str, str]]:
    return [
        (page, "has a ceiling but the page does not exist, delete the entry")
        for page in ceilings["pages"]
        if page not in pages
    ]


def inherited(entry: dict, sources: list[dict]) -> bool:
    """Whether one removed page's ceilings cover every metric of a split page's entry."""
    return any(
        all(metric in source and value <= source[metric] for metric, value in entry.items())
        for source in sources
    )


def raised_entries(ceilings: dict, baseline: dict, pages: dict) -> list[tuple[str, str]]:
    # A page split into several leaves its ceilings behind: the baseline's
    # entries for pages that no longer exist are what a new page may carry.
    sources = [entry for page, entry in baseline["pages"].items() if page not in pages]
    found = []
    for page, entry in ceilings["pages"].items():
        base = baseline["pages"].get(page)
        if base is None and inherited(entry, sources):
            continue
        if base is None:
            found.append((page, "is a new ceiling; a page not in the baseline meets the budget"))
            continue
        for metric, value in entry.items():
            if metric not in base:
                found.append((page, f"{metric} gained a ceiling the baseline does not have"))
            elif value > base[metric]:
                found.append((page, f"{metric} ceiling raised from {base[metric]} to {value}"))
    return found


def read_pages(root: Path) -> dict[str, dict]:
    docs = root / "docs"
    return {
        path.relative_to(root).as_posix(): measure_page(path.read_text(encoding="utf-8"))
        for path in sorted(docs.rglob("*.md"))
    }


def seed(pages: dict[str, dict], ceilings: dict) -> dict:
    entries = {}
    for page, measured in sorted(pages.items()):
        reference = is_reference(page, ceilings)
        over = {
            metric: measured[metric]
            for metric in METRICS
            if measured[metric] > budget(metric, reference)
        }
        if over:
            entries[page] = over
    return {"reference_pages": ceilings["reference_pages"], "pages": entries}


def dump(ceilings: dict) -> str:
    return json.dumps(ceilings, indent=2) + "\n"


def lint(root: Path, baseline: dict | None) -> tuple[list[str], dict]:
    ceilings_path = root / "scripts" / "docs-lint-ceilings.json"
    ceilings = parse_ceilings(ceilings_path.read_text(encoding="utf-8"), ceilings_path.name)
    pages = read_pages(root)
    if not pages:
        raise CeilingsError(f"no pages found under {root / 'docs'}: the root is wrong")

    problems: list[tuple[str, str]] = []
    for page, measured in pages.items():
        entry = ceilings["pages"].get(page, {})
        for finding in page_findings(page, measured, entry, is_reference(page, ceilings)):
            problems.append((page, finding))
    problems += stale_entries(pages, ceilings)
    if baseline is not None:
        problems += raised_entries(ceilings, baseline, pages)

    report = [f"{page}: {finding}" for page, finding in problems]
    for page in dict.fromkeys(page for page, _ in problems):
        measured = pages.get(page)
        if measured:
            values = ", ".join(f"{metric} {measured[metric]}" for metric in METRICS)
            report.append(f"  measured {page}: {values}")
    return report, pages


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
            ceilings_path = args.root / "scripts" / "docs-lint-ceilings.json"
            current = parse_ceilings(ceilings_path.read_text(encoding="utf-8"), ceilings_path.name)
            sys.stdout.write(dump(seed(read_pages(args.root), current)))
            return 0
        report, _ = lint(args.root, baseline)
    except (CeilingsError, OSError) as error:
        print(f"docs-lint: {error}", file=sys.stderr)
        return 2

    if not report:
        return 0
    print("\n".join(report))
    print(
        f"\ndocs-lint: {sum(not line.startswith('  ') for line in report)} finding(s). "
        "Budgets and the ceilings file: scripts/docs-lint.py, CONTRIBUTING.md."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
