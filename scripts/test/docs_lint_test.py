#!/usr/bin/env python3
"""
scripts/docs-lint.py: each rule fires on a fixture tree, at its boundary, and
stays quiet one step inside it. The lint is what holds a split page small, so a
rule that quietly stopped firing would let the pages regrow.

Mutation checks: change `>` to `>=` in `page_findings` and the "exactly at the
budget" cases fail; drop the `fence is not None` skip in `measure_page` and the
fenced-code cases fail; delete the `raised_entries` call in `lint` and the
baseline cases fail; change `>` to `>=` in `new_entries` and the exact-allowance
split case fails; drop the `+ MOVE_LINK_SLACK` in `new_entries`, apply the slack
without `moved(...)`, or apply it to a count in `raised_entries` and the move cases
fail.

Run: python3 scripts/test/docs_lint_test.py
"""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "docs-lint.py"

spec = importlib.util.spec_from_file_location("docs_lint", SCRIPT)
dl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dl)

PASSED = 0
FAILED = 0

FRONT = "---\ndescription: A page.\n---\n"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok    {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def page_of_lines(count: int) -> str:
    """A page of exactly `count` lines, front matter included."""
    return FRONT + "\n".join(["text"] * (count - 3)) + "\n"


def tree(pages: dict[str, str], ceilings: dict | None = None) -> Path:
    root = Path(tempfile.mkdtemp(prefix="docs-lint-test-"))
    for name, text in pages.items():
        path = root / "docs" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    ceilings = ceilings or {"reference_pages": [], "pages": {}}
    (root / "scripts").mkdir()
    (root / "scripts" / "docs-lint-ceilings.json").write_text(json.dumps(ceilings), encoding="utf-8")
    return root


def run(root: Path, *extra: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = dl.main(["--root", str(root), *extra])
    return code, out.getvalue()


def fails(pages: dict[str, str], ceilings: dict | None = None, *extra: str) -> str | None:
    """The report if the lint rejects this tree, None if it passes."""
    code, out = run(tree(pages, ceilings), *extra)
    return out if code == 1 else None


def passes(pages: dict[str, str], ceilings: dict | None = None, *extra: str) -> bool:
    code, out = run(tree(pages, ceilings), *extra)
    return code == 0 and out == ""


def cfg(pages: dict | None = None, reference: list[str] | None = None) -> dict:
    return {"reference_pages": reference or [], "pages": pages or {}}


def body(text: str) -> dict[str, str]:
    return {"a.md": FRONT + text + "\n"}


print("lines per page")
check("600 lines is within the budget", passes({"a.md": page_of_lines(600)}))
report = fails({"a.md": page_of_lines(601)})
check("601 lines fails and names the page", report is not None and "a.md: 601 lines" in report, str(report))
check("a failure prints the page's measurements", report is not None and "measured docs/a.md" in report)
reference = cfg(reference=["docs/ref/*.md"])
check("a reference page may hold 1,000 lines", passes({"ref/a.md": page_of_lines(1000)}, reference))
check("a reference page fails at 1,001", fails({"ref/a.md": page_of_lines(1001)}, reference) is not None)
check("a page outside the reference globs keeps 600", fails({"a.md": page_of_lines(601)}, reference) is not None)

print("line length")
check("a 400-character line passes", passes(body("x" * 400)))
report = fails(body("x" * 401))
check("a 401-character line fails", report is not None and "401 characters in the longest line" in report, str(report))
check("it counts the long lines too", report is not None and "1 lines over 400 characters" in report)
check("a long line inside a code fence still counts", fails(body("```\n" + "x" * 401 + "\n```")) is not None)

print("table cells")
check("a 200-character cell passes", passes(body("| a | " + "x" * 200 + " |")))
report = fails(body("| a | " + "x" * 201 + " |"))
check("a 201-character cell fails", report is not None and "201 characters in the longest table cell" in report, str(report))
check("an escaped pipe does not end a cell", fails(body("| " + "x" * 150 + r"\|" + "y" * 60 + " |")) is not None)
check("a pipe in a code span does not end a cell", fails(body("| `" + "x" * 150 + "|" + "y" * 60 + "` |")) is not None)
check("cells are split on a bare pipe", passes(body("| " + "x" * 150 + " | " + "y" * 150 + " |")))
check("a fenced table is not a table", passes(body("```\n| " + "x" * 250 + " |\n```")))

print("history phrases")
for phrase in (
    "The panel used to sit on the right.",
    "That held until #123 landed.",
    "It was broken since #45 merged.",
    "Formerly a tab.",
    "It previously refused this.",
    "The flag was renamed in March.",
    "The helper was removed.",
    "The API was moved here.",
    "The hook was replaced.",
):
    report = fails(body(phrase))
    check(f"counted: {phrase}", report is not None and "1 history phrases" in report, str(report))
check("an issue number in a heading is counted", fails(body("## The panel (#123)")) is not None)
check("an issue number in running text is not", passes(body("The panel is described in #123.")))
check("the passive 'is used to' is not history", passes(body("It is used to build the URL.")))
check("'are used to' and 'get used to' are not history", passes(body("They are used to a, and get used to b.")))
check("two phrases on a page are two", "2 history phrases" in (fails(body("It used to be x.\nIt previously was y.")) or ""))
check("history inside a code fence is skipped", passes(body("```\n# note #123\nused to be\n```")))
check("history after a closed fence is counted", fails(body("```\ncode\n```\nIt used to be x.")) is not None)
check("a longer fence closes only on a fence at least as long", fails(body("````\n```\nstill code\n````\nIt used to be x.")) is not None)
check("rationale is not history", passes(body("The cap is 5 because the dialog cannot show more.")))

print("front-matter description")
check("a page with a description passes", passes({"a.md": FRONT}))
check("a page with no front matter fails", fails({"a.md": "# Title\n"}) is not None)
check("front matter without a description fails", fails({"a.md": "---\ntitle: T\n---\n# Title\n"}) is not None)
check("an empty description fails", fails({"a.md": "---\ndescription:\n---\n"}) is not None)
check("a block-scalar description passes", passes({"a.md": "---\ndescription: >-\n  A page.\n---\n"}))
check("a description after the front matter does not count", fails({"a.md": "---\ntitle: T\n---\ndescription: x\n"}) is not None)
report = fails({"a.md": "# Title\n"})
check("the failure says what the description is for", report is not None and "description" in report)

print("ceilings")
long_line = {"a.md": FRONT + "x" * 500 + "\n"}
at = cfg({"docs/a.md": {"max_line": 500, "long_lines": 1}})
check("a page at its ceiling passes", passes(long_line, at))
over = {"a.md": FRONT + "x" * 501 + "\n"}
report = fails(over, at)
check("a page above its ceiling fails", report is not None and "over this page's ceiling of 500" in report, str(report))
check("a ceiling holds one metric and not the others", fails({"a.md": FRONT + "x" * 500 + "\nIt used to be x.\n"}, at) is not None)
stale = cfg({"docs/a.md": {"max_line": 500}})
report = fails(body("short"), stale)
check("a ceiling on a page now within budget is stale", report is not None and "stale ceiling for max_line" in report, str(report))
check("a ceiling at the budget is stale too", fails(body("x" * 400), cfg({"docs/a.md": {"max_line": 800}})) is not None)
report = fails(body("short"), cfg({"docs/gone.md": {"max_line": 500}}))
check("a ceiling for a page that is gone is stale", report is not None and "docs/gone.md" in report and "does not exist" in report, str(report))
check("a stale entry does not hide behind another metric", fails(long_line, cfg({"docs/a.md": {"max_line": 500, "long_lines": 1, "history": 3}})) is not None)

print("ceilings may only go down")
base = cfg({"docs/a.md": {"max_line": 500, "long_lines": 1}})
baseline_file = Path(tempfile.mkdtemp(prefix="docs-lint-base-")) / "base.json"
baseline_file.write_text(json.dumps(base), encoding="utf-8")
args = ("--baseline", str(baseline_file))
check("an unchanged ceiling passes against the baseline", passes(long_line, base, *args))
shrunk_page = {"a.md": FRONT + "x" * 450 + "\n"}
lowered = cfg({"docs/a.md": {"max_line": 450, "long_lines": 1}})
check("a ceiling lowered from the baseline passes", passes(shrunk_page, lowered, *args))
raised = cfg({"docs/a.md": {"max_line": 501, "long_lines": 1}})
report = fails(over, raised, *args)
check("a ceiling raised by one fails", report is not None and "ceiling raised from 500 to 501" in report, str(report))
check("without a baseline the same raise passes", passes(over, raised))
new_metric = cfg({"docs/a.md": {"max_line": 500, "long_lines": 1, "history": 1}})
page = {"a.md": FRONT + "x" * 500 + "\nIt used to be x.\n"}
check("a metric the baseline had no ceiling for fails", fails(page, new_metric, *args) is not None)
two_pages = {"a.md": FRONT + "x" * 500 + "\n", "b.md": FRONT + "y" * 450 + "\n"}
added = cfg({"docs/a.md": {"max_line": 500, "long_lines": 1}, "docs/b.md": {"max_line": 450, "long_lines": 1}})
report = fails(two_pages, added, *args)
check("a new entry fails: a new page meets the budget", report is not None and "docs/b.md" in report and "new ceiling" in report, str(report))
dropped_page = {"a.md": FRONT}
check("dropping an entry passes", passes(dropped_page, cfg(), *args))

print("a split may carry its page's ceilings")
big = cfg({"docs/big.md": {"max_line": 900, "long_lines": 3, "history": 2}})
big_file = Path(tempfile.mkdtemp(prefix="docs-lint-base-")) / "big.json"
big_file.write_text(json.dumps(big), encoding="utf-8")
split_args = ("--baseline", str(big_file))
halves = {"a.md": FRONT + "x" * 900 + "\nIt used to be x.\n", "b.md": FRONT + ("y" * 700 + "\n") * 2}
carried = cfg({"docs/a.md": {"max_line": 900, "long_lines": 1, "history": 1},
               "docs/b.md": {"max_line": 700, "long_lines": 2}})
check("pages that split an entry's page may hold its counts between them", passes(halves, carried, *split_args))
heavier = cfg({"docs/a.md": {"max_line": 900, "long_lines": 2, "history": 1},
               "docs/b.md": {"max_line": 700, "long_lines": 2}})
heavier_pages = {"a.md": FRONT + ("x" * 900 + "\n") * 2 + "It used to be x.\n", "b.md": halves["b.md"]}
report = fails(heavier_pages, heavier, *split_args)
check("a count summed over the new pages may not exceed the retired page's",
      report is not None and "long_lines ceilings of new pages total more than the 3" in report, str(report))
slack = dl.MOVE_LINK_SLACK
at_slack = cfg({"docs/a.md": {"max_line": 900 + slack, "long_lines": 1, "history": 1},
                "docs/b.md": {"max_line": 700, "long_lines": 2}})
at_slack_pages = {"a.md": FRONT + "x" * (900 + slack) + "\nIt used to be x.\n", "b.md": halves["b.md"]}
check("a split's longest line may exceed the retired page's by the link slack",
      passes(at_slack_pages, at_slack, *split_args))
wider = cfg({"docs/a.md": {"max_line": 901 + slack, "long_lines": 1, "history": 1},
             "docs/b.md": {"max_line": 700, "long_lines": 2}})
wider_pages = {"a.md": FRONT + "x" * (901 + slack) + "\nIt used to be x.\n", "b.md": halves["b.md"]}
report = fails(wider_pages, wider, *split_args)
check("a longest line may not exceed the retired page's by more than the slack",
      report is not None and f"max_line ceiling {901 + slack} is above the {900 + slack}" in report, str(report))
rewrapped = cfg({"docs/a.md": {"max_line": 900, "long_lines": 1, "history": 2},
                 "docs/b.md": {"max_line": 700, "long_lines": 2, "history": 1}})
rewrapped_pages = {"a.md": FRONT + "x" * 900 + "\nIt used to be x.\nIt used to be y.\n",
                   "b.md": FRONT + ("y" * 700 + "\n") * 2 + "It used to be z.\n"}
check("a split's history may total a tenth more than the retired page's",
      passes(rewrapped_pages, rewrapped, *split_args))
twice = cfg({"docs/a.md": {"max_line": 900, "long_lines": 1, "history": 2},
             "docs/b.md": {"max_line": 700, "long_lines": 2, "history": 2}})
twice_pages = {"a.md": rewrapped_pages["a.md"], "b.md": FRONT + ("y" * 700 + "\n") * 2 + "It used to be z.\nIt used to be w.\n"}
report = fails(twice_pages, twice, *split_args)
check("a split's history may not total more than that allowance",
      report is not None and "history ceilings of new pages total more than the 3" in report, str(report))

print("a move re-aims links in other pages")
linker = cfg({"docs/linker.md": {"max_line": 500, "long_lines": 1}, "docs/old.md": {"max_line": 900, "long_lines": 1}})
linker_file = Path(tempfile.mkdtemp(prefix="docs-lint-base-")) / "linker.json"
linker_file.write_text(json.dumps(linker), encoding="utf-8")
linker_args = ("--baseline", str(linker_file))
grown = {"linker.md": FRONT + "x" * (500 + slack) + "\n", "new.md": FRONT + "short\n"}
grown_cfg = cfg({"docs/linker.md": {"max_line": 500 + slack, "long_lines": 1}})
check("a page that links to a retired page may grow its longest line by the slack",
      passes(grown, grown_cfg, *linker_args))
too_grown = {"linker.md": FRONT + "x" * (501 + slack) + "\n", "new.md": FRONT + "short\n"}
too_grown_cfg = cfg({"docs/linker.md": {"max_line": 501 + slack, "long_lines": 1}})
report = fails(too_grown, too_grown_cfg, *linker_args)
check("it may not grow by more than the slack",
      report is not None and "max_line ceiling raised from 500" in report, str(report))
kept = cfg({"docs/linker.md": {"max_line": 500 + slack, "long_lines": 1}, "docs/old.md": {"max_line": 900, "long_lines": 1}})
report = fails({"linker.md": grown["linker.md"], "old.md": FRONT + "x" * 900 + "\n"}, kept, *linker_args)
check("without a retired page the same growth is a raised ceiling",
      report is not None and "max_line ceiling raised from 500" in report, str(report))
report = fails({"a.md": page_of_lines(700)}, cfg({"docs/a.md": {"lines": 700}}), *split_args)
check("a metric the retired page had no ceiling for may not appear on a new page",
      report is not None and "lines ceilings of new pages total more than the 0" in report, str(report))

more_long = cfg({"docs/linker.md": {"max_line": 500, "long_lines": 2}})
report = fails({"linker.md": FRONT + ("x" * 500 + "\n") * 2, "new.md": FRONT + "short\n"}, more_long, *linker_args)
check("a moved page's count of long lines may not rise",
      report is not None and "long_lines ceiling raised from 1 to 2" in report, str(report))

print("malformed input")
for label, ceilings_text in (
    ("not JSON", "{"),
    ("an unknown key", '{"reference_pages": [], "pages": {}, "extra": 1}'),
    ("an unknown metric", '{"reference_pages": [], "pages": {"docs/a.md": {"words": 3}}}'),
    ("a negative ceiling", '{"reference_pages": [], "pages": {"docs/a.md": {"lines": -1}}}'),
    ("a boolean ceiling", '{"reference_pages": [], "pages": {"docs/a.md": {"lines": true}}}'),
    ("an empty entry", '{"reference_pages": [], "pages": {"docs/a.md": {}}}'),
):
    root = tree({"a.md": FRONT})
    (root / "scripts" / "docs-lint-ceilings.json").write_text(ceilings_text, encoding="utf-8")
    code, _ = run(root)
    check(f"{label} is exit 2, not a pass", code == 2)
empty = Path(tempfile.mkdtemp(prefix="docs-lint-empty-"))
(empty / "scripts").mkdir()
(empty / "scripts" / "docs-lint-ceilings.json").write_text(json.dumps(cfg()), encoding="utf-8")
(empty / "docs").mkdir()
code, _ = run(empty)
check("a tree with no pages is exit 2: it scanned nothing", code == 2)
code, _ = run(Path(tempfile.mkdtemp(prefix="docs-lint-missing-")))
check("a missing ceilings file is exit 2", code == 2)

print("--measure")
mixed = {
    "a.md": FRONT + "x" * 500 + "\n",
    "ref/r.md": page_of_lines(1200),
    "ok.md": FRONT + "fine\n",
}
root = tree(mixed, cfg(reference=["docs/ref/*.md"]))
code, out = run(root, "--measure")
measured = json.loads(out)
check("--measure lists exactly the pages over budget", sorted(measured["pages"]) == ["docs/a.md", "docs/ref/r.md"])
check("--measure holds a reference page to 1,000", measured["pages"]["docs/ref/r.md"] == {"lines": 1200})
check("--measure keeps the reference globs", measured["reference_pages"] == ["docs/ref/*.md"])
(root / "scripts" / "docs-lint-ceilings.json").write_text(out, encoding="utf-8")
code, out = run(root)
check("the tree passes against its own --measure", code == 0 and out == "", out)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
