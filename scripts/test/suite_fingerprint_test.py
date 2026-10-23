#!/usr/bin/env python3
"""
scripts/suite-fingerprint.py: what a suite's fingerprint reads, and what it
must not. PR CI skips the app or engine matrix when a run of the same pull
request already passed it on the same fingerprint, so a fingerprint that
misses an input skips a suite that should have run.

Mutation checks: make `glob_regex` translate `**` as `[^/]*` and the nested
`app/**` case fails; hash only each file's mode and path, not its object id,
and "an engine file the app reads changes the app fingerprint" fails.

Run: python3 scripts/test/suite_fingerprint_test.py
"""

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "suite-fingerprint.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "pr-tests.yml"

spec = importlib.util.spec_from_file_location("suite_fingerprint", SCRIPT)
sf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sf)

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok    {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def matches(pattern: str, path: str) -> bool:
    return bool(sf.glob_regex(pattern).match(path))


print("globs, as picomatch reads the forms the filters use")
check("app/** takes a nested file", matches("app/**", "app/src/a/b.ts"))
check("app/** takes a dotfile", matches("app/**", "app/.eslintrc.json"))
check("app/** does not take a sibling", not matches("app/**", "apps/x.ts"))
check("a literal path is exact", matches("install.sh", "install.sh") and not matches("install.sh", "x/install.sh"))
check("*.md stays at the root", matches("*.md", "README.md") and not matches("*.md", "docs/a.md"))
check("**/*.md reaches any depth", matches("**/*.md", "README.md") and matches("**/*.md", "docs/x/a.md"))
try:
    sf.glob_regex("app/{a,b}/**")
    check("brace syntax is refused, not misread", False)
except ValueError:
    check("brace syntax is refused, not misread", True)

print("the filters block of pr-tests.yml")
text = WORKFLOW.read_text(encoding="utf-8")
filters = sf.read_filters(text, "area")
for name in ("app", "app_doc_fixtures", "app_engine_inputs", "app_root_inputs", "engine"):
    check(f"'{name}' is read with patterns", bool(filters.get(name)), str(filters.get(name)))
try:
    import yaml

    workflow = yaml.safe_load(text)
    step = next(s for s in workflow["jobs"]["changes"]["steps"] if s.get("id") == "area")
    check("the line reader agrees with a YAML parser", filters == yaml.safe_load(step["with"]["filters"]))
except ImportError:
    print("  skip  PyYAML is not installed; the cross-check did not run")
try:
    sf.read_filters(text.replace("              - 'install.sh'\n", "              - install.sh\n", 1), "area")
    check("an unquoted item is an error, not skipped", False)
except ValueError:
    check("an unquoted item is an error, not skipped", True)

print("what changes a fingerprint")
WF = """jobs:
  changes:
    steps:
      - id: area
        with:
          filters: |
            app:
              - 'app/**'
              - 'VERSION'
              - '!**/*.md'
            app_engine_inputs:
              - 'engine/fixtures/shared.json'
            engine:
              - 'engine/**'
"""


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def commit(repo: Path, files: dict[str, str]) -> None:
    for path, body in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c")


def fp(repo: Path, *names: str) -> str:
    return sf.fingerprint(repo / "wf.yml", "area", list(names), repo)[0]


with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    git(repo, "init", "-q")
    commit(repo, {"wf.yml": WF, "app/a.ts": "1", "app/README.md": "x", "VERSION": "1",
                  "engine/x.cpp": "1", "engine/fixtures/shared.json": "{}", "docs/n.md": "n"})
    app0 = fp(repo, "app", "app_engine_inputs")
    eng0 = fp(repo, "engine")

    commit(repo, {"engine/x.cpp": "2"})
    check("an engine-only edit leaves the app fingerprint", fp(repo, "app", "app_engine_inputs") == app0)
    check("an engine-only edit changes the engine fingerprint", fp(repo, "engine") != eng0)

    commit(repo, {"engine/fixtures/shared.json": "{1}"})
    check("an engine file the app reads changes the app fingerprint",
          fp(repo, "app", "app_engine_inputs") != app0)

    app1 = fp(repo, "app", "app_engine_inputs")
    eng1 = fp(repo, "engine")
    commit(repo, {"app/deep/b.ts": "1"})
    check("an input edit changes it (a nested app file)", fp(repo, "app", "app_engine_inputs") != app1)
    check("an app-only edit leaves the engine fingerprint", fp(repo, "engine") == eng1)

    app2 = fp(repo, "app", "app_engine_inputs")
    commit(repo, {"app/README.md": "y"})
    check("an excluded-by-! input still counts (superset, never a wrong reuse)",
          fp(repo, "app", "app_engine_inputs") != app2)

    app3 = fp(repo, "app", "app_engine_inputs")
    commit(repo, {"docs/n.md": "m"})
    check("a file no filter names changes nothing", fp(repo, "app", "app_engine_inputs") == app3)

    git(repo, "mv", "app/a.ts", "app/c.ts")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "mv")
    check("a rename changes it", fp(repo, "app", "app_engine_inputs") != app3)

    check("the same tree gives the same fingerprint",
          fp(repo, "app", "app_engine_inputs") == fp(repo, "app_engine_inputs", "app"))

    try:
        fp(repo, "nope")
        check("an unknown filter name is an error", False)
    except ValueError:
        check("an unknown filter name is an error", True)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
