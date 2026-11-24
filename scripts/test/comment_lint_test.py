#!/usr/bin/env python3
"""
scripts/comment-lint.py: each pattern fires on a planted comment, each excluded
phrasing stays quiet, and the ceilings only go down. The lint is what keeps the
history out of source comments once they are trimmed, so a pattern that quietly
stopped matching would let it back in.

Mutation checks: drop `until #\\d+` from `_HISTORY` and the "until #N" case
fails; drop the `(?<!\\bis )`-style lookbehinds and the passive cases fail; add
`now` to the patterns and the OUT cases fail; delete the `stale ceiling` branch
in `file_findings` and the stale case fails; delete the `raised_entries` call in
`lint` and the baseline cases fail; change `>` to `>=` in `new_entries` and the
exact-handover split case fails; delete the empty-scan check in `scan` and the
empty-root case fails.

Run: python3 scripts/test/comment_lint_test.py
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
SCRIPT = REPO_ROOT / "scripts" / "comment-lint.py"

spec = importlib.util.spec_from_file_location("comment_lint", SCRIPT)
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)

PASSED = 0
FAILED = 0

SRC = "engine/src/a.cpp"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok    {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def tree(files: dict[str, str], ceilings: dict | None = None) -> Path:
    root = Path(tempfile.mkdtemp(prefix="comment-lint-test-"))
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    (root / "scripts").mkdir(exist_ok=True)
    ceilings = ceilings or {"files": {}}
    (root / "scripts" / cl.CEILINGS_FILE).write_text(json.dumps(ceilings), encoding="utf-8")
    return root


def run(root: Path, *extra: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = cl.main(["--root", str(root), *extra])
    return code, out.getvalue()


def fails(files: dict[str, str], ceilings: dict | None = None, *extra: str) -> str | None:
    """The report if the lint rejects this tree, None if it passes."""
    code, out = run(tree(files, ceilings), *extra)
    return out if code == 1 else None


def passes(files: dict[str, str], ceilings: dict | None = None, *extra: str) -> bool:
    code, out = run(tree(files, ceilings), *extra)
    return code == 0 and out == ""


def cfg(files: dict | None = None) -> dict:
    return {"files": files or {}}


def counted(text: str) -> int:
    return len(cl.history_lines(text))


def baseline_args(ceilings: dict) -> tuple[str, str]:
    path = Path(tempfile.mkdtemp(prefix="comment-lint-base-")) / "base.json"
    path.write_text(json.dumps(ceilings), encoding="utf-8")
    return ("--baseline", str(path))


print("history phrases that are counted")
for phrase in (
    "The panel used to sit on the right.",
    "Used to be a tab.",
    "That held until #123 landed.",
    "Held until #4.",
    "It has been broken since #45.",
    "It was broken since #45 merged.",
    "#12 changed the order.",
    "#12 moved the call.",
    "#12 added the guard.",
    "#12 removed the guard.",
    "#12 replaced the guard.",
    "#12 renamed the guard.",
    "#12 introduced the guard.",
    "#12 fixed the guard.",
    "#12 landed the guard.",
    "#12 shipped the guard.",
    "#12 merged the guard.",
    "Formerly a tab.",
    "It previously refused this.",
):
    check(f"counted: {phrase}", counted(f"// {phrase}\n") == 1, phrase)
check("a pattern is case-insensitive", counted("// FORMERLY a tab.\n") == 1)
check("two phrases on one line count once", counted("// It used to be x, previously y.\n") == 1)
check("two lines are two", counted("// It used to be x.\n// It previously was y.\n") == 2)

print("phrasing that is not counted")
for phrase in (
    "The helper was renamed in March.",
    "The call was moved here.",
    "The guard was removed.",
    "The hook was replaced.",
    "Hold off before #123 lands.",
    "The pre-#123 behaviour is kept.",
    "The flag is no longer read.",
    "It is now a Set.",
    "The panel is described in #123.",
    "Fixed in #123.",
    "See #123 for the move.",
    "Added by a user, not by #123.",
    "The cap is 5 because the dialog cannot show more.",
):
    check(f"not counted: {phrase}", counted(f"// {phrase}\n") == 0, phrase)
for phrase in (
    "It is used to build the URL.",
    "They are used to a, and get used to b.",
    "It was used to seed the table.",
    "Being used to hold it, the lock is a mutex.",
    "That has been used to carry the id, and gets used to log it, and got used to retry.",
    "It would be used to compare. Were used to hash.",
):
    check(f"passive 'used to' is not history: {phrase}", counted(f"// {phrase}\n") == 0, phrase)

print("what is a comment line")
check("a line comment", counted("// used to be x\n") == 1)
check("an indented line comment", counted("\t\t// used to be x\n") == 1)
check("a block comment on one line", counted("/* used to be x */\n") == 1)
check("a doc comment line", counted("/**\n * used to be x\n */\n") == 1)
check("a block line with no leading star", counted("/*\n used to be x\n*/\n") == 1)
check("every line of a long block counts, not only the first", counted("/*\nfoo\nbar\n used to be x\n*/\n") == 1)
check("a line inside an open block counts, after it closes it does not",
      counted("/*\nfoo\n*/\nused to be x;\n") == 0)
check("a JSX comment", counted("{/* used to be x */}\n") == 1)
check("a JSX comment opened and closed across lines", counted("{/*\n used to be x\n*/}\n") == 1)
check("a one-line block does not leave the next line open",
      counted("/* a */\nused to be x;\n") == 0)
check("code is not a comment", counted("const used_to = previously(); // ok\nformerly();\n") == 0)
check("a phrase in a string is not a comment", counted('const s = "used to be";\n') == 0)
check("a trailing comment is not scanned (documented limit)", counted("run(); // used to be x\n") == 0)
check("a trailing block comment is not scanned", counted("run(); /* previously */\n") == 0)
check("CRLF line endings", counted("// used to be x\r\n// fine\r\n") == 1)
check("no text, no lines", counted("") == 0)

print("scope")
for path in (
    "engine/src/a.cpp",
    "engine/src/http/routes/execution.cpp",
    "engine/include/vayu/types.hpp",
    "engine/include/vayu/x.h",
    "app/src/a.ts",
    "app/src/modules/x/Y.tsx",
    "app/electron/main.ts",
    "app/electron/mcp/server.mjs",
    "app/electron/preload.cjs",
):
    check(f"in scope: {path}", cl.in_scope(path), path)
for path in (
    "engine/tests/a_test.cpp",
    "engine/vendor/lib/a.cpp",
    "app/src/test/setup.ts",
    "app/src/a.test.ts",
    "app/src/a.test.tsx",
    "app/src/lib/x.testkit.ts",
    "app/electron/a.test.ts",
    "app/src/x/__fixtures__/a.ts",
    "app/src/a.css",
    "app/src/a.json",
    "app/src/a.md",
    "app/electron/a.js",
    "scripts/perf/a.mjs",
    "docs/a.ts",
    "app/srcs/a.ts",
    "xapp/src/a.ts",
):
    check(f"out of scope: {path}", not cl.in_scope(path), path)
files = {
    "engine/src/a.cpp": "// fine\n",
    "app/src/a.test.ts": "// used to be x\n",
    "engine/tests/a_test.cpp": "// used to be x\n",
    "docs/a.ts": "// used to be x\n",
}
check("a test file's history is not measured", passes(files))
check("a file git does not know about but would is scanned",
      fails({SRC: "// used to be x\n"}) is not None)
root = tree({SRC: "// used to be x\n", ".gitignore": "ignored/\n", "engine/src/ignored/b.cpp": "// used to be y\n"})
code, out = run(root)
check("an ignored file is not scanned", code == 1 and "ignored" not in out, out)

print("ceilings")
planted = {SRC: "// fine\n// used to be x\n"}
report = fails(planted)
check("a file with history and no entry fails and names the line",
      report is not None and f"{SRC}: 1 history comment line(s) and no ceiling" in report
      and f"{SRC}:2: // used to be x" in report, str(report))
check("a file at its ceiling passes", passes(planted, cfg({SRC: 1})))
two = {SRC: "// used to be x\n// previously y\n"}
report = fails(two, cfg({SRC: 1}))
check("a file above its ceiling fails", report is not None and "over this file's ceiling of 1" in report, str(report))
check("a file under its ceiling still passes", passes(planted, cfg({SRC: 2})))
report = fails({SRC: "// fine\n"}, cfg({SRC: 1}))
check("a ceiling on a file now at zero is stale", report is not None and "stale ceiling" in report, str(report))
report = fails({SRC: "// fine\n"}, cfg({"engine/src/gone.cpp": 1}))
check("a ceiling for a file that is gone is stale",
      report is not None and "engine/src/gone.cpp: has a ceiling but is not a scanned file" in report, str(report))
report = fails({SRC: "// fine\n", "app/src/a.test.ts": "// used to be x\n"}, cfg({"app/src/a.test.ts": 1}))
check("a ceiling for a file out of scope is stale",
      report is not None and "app/src/a.test.ts: has a ceiling" in report, str(report))
check("a ceiling is per file: another file's room is not shared",
      fails({SRC: planted[SRC], "engine/src/b.cpp": "// used to be y\n"}, cfg({SRC: 5})) is not None)
check("a zero ceiling on a clean file is stale, not a pass", fails({SRC: "// fine\n"}, cfg({SRC: 0})) is not None)

print("ceilings may only go down")
base = cfg({SRC: 2})
args = baseline_args(base)
check("an unchanged ceiling passes against the baseline", passes(two, base, *args))
check("a ceiling lowered from the baseline passes", passes(planted, cfg({SRC: 1}), *args))
report = fails({SRC: "// used to be x\n// previously y\n// formerly z\n"}, cfg({SRC: 3}), *args)
check("a ceiling raised by one fails",
      report is not None and "ceiling raised from 2 to 3" in report, str(report))
check("without a baseline the same raise passes",
      passes({SRC: "// used to be x\n// previously y\n// formerly z\n"}, cfg({SRC: 3})))
other = {SRC: "// used to be x\n// previously y\n", "engine/src/b.cpp": "// used to be y\n"}
report = fails(other, cfg({SRC: 2, "engine/src/b.cpp": 1}), *args)
check("a new entry fails: a file the baseline has no entry for starts at zero",
      report is not None and "engine/src/b.cpp: new ceilings total more than the 0" in report, str(report))
check("dropping an entry passes", passes({SRC: "// fine\n"}, cfg(), *args))

print("a split or rename may carry the retired entry")
big = cfg({"engine/src/big.cpp": 3})
split_args = baseline_args(big)
halves = {
    "engine/src/a.cpp": "// used to be x\n// previously y\n",
    "engine/src/b.cpp": "// formerly z\n",
}
check("new entries may together hold what the retired entry held",
      passes(halves, cfg({"engine/src/a.cpp": 2, "engine/src/b.cpp": 1}), *split_args))
check("a rename hands the whole count to one file",
      passes({"engine/src/c.cpp": "// used to be x\n// previously y\n// formerly z\n"},
             cfg({"engine/src/c.cpp": 3}), *split_args))
heavier = {
    "engine/src/a.cpp": "// used to be x\n// previously y\n// until #1\n",
    "engine/src/b.cpp": "// formerly z\n",
}
report = fails(heavier, cfg({"engine/src/a.cpp": 3, "engine/src/b.cpp": 1}), *split_args)
check("new entries may not total more than the retired entry held",
      report is not None and "new ceilings total more than the 3" in report, str(report))
check("a retired entry's count cannot be spent when the entry stays",
      fails({"engine/src/big.cpp": "// used to be x\n// previously y\n// formerly z\n",
             "engine/src/a.cpp": "// used to be x\n"},
            cfg({"engine/src/big.cpp": 3, "engine/src/a.cpp": 1}), *split_args) is not None)

print("malformed input and an empty scan")
for label, text in (
    ("not JSON", "{"),
    ("an unknown key", '{"files": {}, "extra": 1}'),
    ("a missing key", "{}"),
    ("a list of files", '{"files": []}'),
    ("a negative ceiling", '{"files": {"engine/src/a.cpp": -1}}'),
    ("a boolean ceiling", '{"files": {"engine/src/a.cpp": true}}'),
    ("a string ceiling", '{"files": {"engine/src/a.cpp": "2"}}'),
):
    root = tree({SRC: "// fine\n"})
    (root / "scripts" / cl.CEILINGS_FILE).write_text(text, encoding="utf-8")
    code, _ = run(root)
    check(f"{label} is exit 2, not a pass", code == 2)
bad_baseline = Path(tempfile.mkdtemp(prefix="comment-lint-base-")) / "bad.json"
bad_baseline.write_text("[]", encoding="utf-8")
code, _ = run(tree({SRC: "// fine\n"}), "--baseline", str(bad_baseline))
check("a malformed baseline is exit 2", code == 2)
code, _ = run(tree({SRC: "// fine\n"}), "--baseline", str(bad_baseline.parent / "absent.json"))
check("a missing baseline file is exit 2", code == 2)
code, out = run(tree({"docs/a.ts": "// used to be x\n", "engine/tests/a_test.cpp": "// fine\n"}))
check("a root that matches no source file is exit 2: it scanned nothing", code == 2 and "no source files" in out, out)
not_a_repo = Path(tempfile.mkdtemp(prefix="comment-lint-norepo-"))
(not_a_repo / "scripts").mkdir()
(not_a_repo / "scripts" / cl.CEILINGS_FILE).write_text(json.dumps(cfg()), encoding="utf-8")
# Stops git looking for a repository above the temp directory, so the case holds
# wherever TMPDIR lives.
os.environ["GIT_CEILING_DIRECTORIES"] = str(not_a_repo.parent)
code, out = run(not_a_repo)
del os.environ["GIT_CEILING_DIRECTORIES"]
check("a root that is not a repository is exit 2", code == 2 and "git ls-files failed" in out, out)
missing = Path(tempfile.mkdtemp(prefix="comment-lint-missing-"))
code, _ = run(missing)
check("a missing ceilings file is exit 2", code == 2)

print("--measure")
mixed = {
    SRC: "// used to be x\n// previously y\n",
    "app/src/b.ts": "// fine\n",
    "app/src/c.tsx": "/*\n formerly z\n*/\n",
    "app/src/d.test.ts": "// used to be x\n",
}
root = tree(mixed)
code, out = run(root, "--measure")
measured = json.loads(out)
check("--measure lists exactly the files with history", measured == {"files": {SRC: 2, "app/src/c.tsx": 1}}, out)
check("--measure sorts its entries", list(measured["files"]) == sorted(measured["files"]))
(root / "scripts" / cl.CEILINGS_FILE).write_text(out, encoding="utf-8")
code, out = run(root)
check("the tree passes against its own --measure", code == 0 and out == "", out)
code, out = run(root, "--measure")
check("--measure is stable once seeded", json.loads(out) == measured)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
