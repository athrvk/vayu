#!/usr/bin/env python3
"""
scripts/test-size-lint.py: each rule fires on a fixture tree, at its boundary, and
stays quiet one step inside it. The lint is what keeps a test file from growing
back to the size it was split from, so a rule that quietly stopped firing would
let it.

Mutation checks: change `>` to `>=` in `file_findings` for the cap and the
"exactly at the cap" case fails; drop the `size > recorded` arm and the
"over its recorded size" case fails; drop the `size <= LINE_CAP` arm and the
stale cases fail; delete the `raised_entries` call in `lint` and the baseline
cases fail; drop the `len(sizes) < MIN_TEST_FILES` check and the empty-scan
case fails; narrow `_TEST_FILE` and the file-kind cases fail.

Run: python3 scripts/test/test_size_lint_test.py
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "test-size-lint.py"

spec = importlib.util.spec_from_file_location("test_size_lint", SCRIPT)
tsl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tsl)

PASSED = 0
FAILED = 0

CAP = tsl.LINE_CAP
FILE = "app/src/a.test.ts"
CPP = "engine/tests/a_test.cpp"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok    {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def lines_of(count: int) -> str:
    return "x\n" * count


def tree(files: dict[str, str], exceptions: dict | None = None) -> Path:
    root = Path(tempfile.mkdtemp(prefix="test-size-lint-test-"))
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    (root / "scripts").mkdir(exist_ok=True)
    exceptions = exceptions if exceptions is not None else {"files": {}}
    (root / tsl.EXCEPTIONS_PATH).write_text(json.dumps(exceptions), encoding="utf-8")
    return root


def run(root: Path, *extra: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = tsl.main(["--root", str(root), *extra])
    return code, out.getvalue()


def fails(files: dict[str, str], exceptions: dict | None = None, *extra: str) -> str | None:
    """The report if the lint rejects this tree, None if it passes."""
    code, out = run(tree(files, exceptions), *extra)
    return out if code == 1 else None


def passes(files: dict[str, str], exceptions: dict | None = None, *extra: str) -> bool:
    code, out = run(tree(files, exceptions), *extra)
    return code == 0 and out == ""


def listed(files: dict[str, int]) -> dict:
    return {"files": files}


def baseline_args(files: dict[str, int]) -> tuple[str, str]:
    path = Path(tempfile.mkdtemp(prefix="test-size-lint-base-")) / "base.json"
    path.write_text(json.dumps(listed(files)), encoding="utf-8")
    return ("--baseline", str(path))


# The real tree holds well over the floor; a fixture tree holds a handful.
tsl.MIN_TEST_FILES = 1

print("the cap")
check("a file exactly at the cap passes", passes({FILE: lines_of(CAP)}))
check("a file one line over the cap with no entry fails", fails({FILE: lines_of(CAP + 1)}) is not None)
report = fails({CPP: lines_of(CAP + 1)}) or ""
check("the failure names the file, its size and the cap", CPP in report and f"{CAP + 1} lines" in report and str(CAP) in report, report)
check("an engine test file is held to the same cap", fails({CPP: lines_of(CAP + 1)}) is not None)

print("which files are test files")
for name in (
    "app/src/a.test.ts",
    "app/src/a.test.tsx",
    "app/src/a.testkit.ts",
    "app/src/a.testkit.tsx",
    "engine/tests/a_test.cpp",
):
    check(f"{name} is held to the cap", fails({name: lines_of(CAP + 1)}) is not None)
for name in (
    "app/src/big.ts",
    "app/src/big.tsx",
    "engine/src/big.cpp",
    "engine/tests/big_helper.hpp",
    "engine/tests/test_helper.cpp",
    "engine/vendor/lib/a_test.cpp",
    "docs/a.test.md",
):
    check(f"{name} is not", passes({FILE: lines_of(1), name: lines_of(CAP * 2)}))

print("how lines are counted")
check("a last line with no newline counts", tsl.line_count(b"a\nb") == 2)
check("a file ending in a newline does not count an empty last line", tsl.line_count(b"a\nb\n") == 2)
check("an empty file is zero lines", tsl.line_count(b"") == 0)
check("CRLF lines count once", tsl.line_count(b"a\r\nb\r\n") == 2)
check("a file of CAP lines without a final newline is at the cap", passes({FILE: lines_of(CAP - 1) + "x"}))
check("a file of one line more without a final newline is over", fails({FILE: lines_of(CAP) + "x"}) is not None)

print("an exception")
big = CAP + 500
check("a file at its recorded size passes", passes({FILE: lines_of(big)}, listed({FILE: big})))
check("a file under its recorded size, still over the cap, passes", passes({FILE: lines_of(big - 1)}, listed({FILE: big})))
report = fails({FILE: lines_of(big + 1)}, listed({FILE: big})) or ""
check("a file one line over its recorded size fails", report != "", report)
check("the failure names the recorded size", f"recorded {big}" in report and "only shrinks" in report, report)

print("a stale entry")
report = fails({FILE: lines_of(CAP)}, listed({FILE: big})) or ""
check("a file now at the cap with an entry fails", "stale" in report, report)
report = fails({FILE: lines_of(10)}, listed({FILE: big})) or ""
check("a file now far under the cap with an entry fails", "stale" in report, report)
report = fails({FILE: lines_of(10)}, listed({"app/src/gone.test.ts": big})) or ""
check("an entry for a file that does not exist fails", "does not exist" in report and "gone.test.ts" in report, report)
root = tree({FILE: lines_of(10)}, listed({FILE: big}))
(root / FILE).unlink()
(root / "app/src/other.test.ts").write_text("x\n", encoding="utf-8")
code, out = run(root)
check("a file deleted from disk but still listed is reported, not a crash", code == 1 and "does not exist" in out, out)

print("an entry of a malformed shape is exit 2")
for label, text in (
    ("not JSON", "{"),
    ("a list", "[]"),
    ("another key", '{"files": {}, "cap": 1}'),
    ("files not an object", '{"files": []}'),
    ("a size at the cap", json.dumps(listed({FILE: CAP}))),
    ("a size under the cap", json.dumps(listed({FILE: 3}))),
    ("a boolean size", json.dumps(listed({FILE: True}))),
    ("a string size", json.dumps(listed({FILE: "2000"}))),
):
    root = tree({FILE: lines_of(1)})
    (root / tsl.EXCEPTIONS_PATH).write_text(text, encoding="utf-8")
    code, _ = run(root)
    check(f"{label} is exit 2, not a pass", code == 2)
missing = tree({FILE: lines_of(1)})
(missing / tsl.EXCEPTIONS_PATH).unlink()
check("a missing exceptions file is exit 2", run(missing)[0] == 2)

print("a scan that found nothing")
tsl.MIN_TEST_FILES = 1000
code, out = run(tree({FILE: lines_of(1)}))
check("a tree with a handful of test files is exit 2: it scanned almost nothing", code == 2 and "fewer than 1000" in out, out)
code, out = run(tree({"docs/a.md": "x\n", "app/src/a.ts": "x\n"}))
check("a root that matches no test file is exit 2", code == 2, out)
tsl.MIN_TEST_FILES = 1
code, out = run(tree({"docs/a.md": "x\n", "app/src/a.ts": "x\n"}))
check("even a floor of one fails on a tree with no test file", code == 2, out)
not_a_repo = Path(tempfile.mkdtemp(prefix="test-size-lint-norepo-"))
(not_a_repo / "scripts").mkdir()
(not_a_repo / tsl.EXCEPTIONS_PATH).write_text(json.dumps(listed({})), encoding="utf-8")
# Stops git looking for a repository above the temp directory, so the case holds
# wherever TMPDIR lives.
os.environ["GIT_CEILING_DIRECTORIES"] = str(not_a_repo.parent)
code, out = run(not_a_repo)
del os.environ["GIT_CEILING_DIRECTORIES"]
check("a root that is not a repository is exit 2", code == 2, out)

print("--baseline")
args = baseline_args({FILE: big})
check("an entry equal to the baseline's passes", passes({FILE: lines_of(big)}, listed({FILE: big}), *args))
args = baseline_args({FILE: big + 100})
check("an entry lower than the baseline's passes", passes({FILE: lines_of(big)}, listed({FILE: big}), *args))
args = baseline_args({FILE: big, CPP: big})
check("an entry removed since the baseline passes", passes({FILE: lines_of(big)}, listed({FILE: big}), *args))
args = baseline_args({FILE: big - 10})
report = fails({FILE: lines_of(big)}, listed({FILE: big}), *args) or ""
check("an entry raised above the baseline's fails", "raised" in report and f"{big - 10}" in report, report)
args = baseline_args({})
report = fails({FILE: lines_of(big)}, listed({FILE: big}), *args) or ""
check("an entry the baseline does not have fails", "new exception" in report, report)
bad_baseline = Path(tempfile.mkdtemp(prefix="test-size-lint-base-")) / "bad.json"
bad_baseline.write_text("[]", encoding="utf-8")
code, _ = run(tree({FILE: lines_of(1)}), "--baseline", str(bad_baseline))
check("a malformed baseline is exit 2", code == 2)
code, _ = run(tree({FILE: lines_of(1)}), "--baseline", str(bad_baseline.parent / "absent.json"))
check("a missing baseline file is exit 2", code == 2)

print("--measure")
root = tree({FILE: lines_of(big), CPP: lines_of(CAP + 1), "app/src/b.test.ts": lines_of(CAP), "app/src/c.ts": lines_of(CAP * 2)})
code, out = run(root, "--measure")
measured = json.loads(out)
check("--measure lists exactly the test files over the cap", measured == listed({FILE: big, CPP: CAP + 1}), out)
check("--measure sorts its entries", list(measured["files"]) == sorted(measured["files"]))
(root / tsl.EXCEPTIONS_PATH).write_text(out, encoding="utf-8")
code, out = run(root)
check("the tree passes against its own --measure", code == 0 and out == "", out)
code, out = run(root, "--measure")
check("--measure is stable once seeded", json.loads(out) == measured)

print("a staged file counts too")
root = tree({FILE: lines_of(CAP + 1)})
subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
check("a staged file over the cap fails", run(root)[0] == 1)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
