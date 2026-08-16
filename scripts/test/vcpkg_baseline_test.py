#!/usr/bin/env python3
"""
build.py's stale-vcpkg-baseline self-heal (issue #692).

A vcpkg registry clone that predates the `builtin-baseline` in
engine/vcpkg.json fails dependency resolution with vcpkg's most misleading
error - "path 'versions/baseline.json' exists on disk, but not in <sha>" - once
per dependency. It reads as a corrupt tree and is only a clone that has not
been updated since the pin moved. Baseline bumps are routine by design, so this
is on the path of every environment that has sat still.

Fetching is only half the cure, and the half that produces a second confusing
error ("no version database entry for <port> at <version>"): vcpkg reads the
baseline map out of the pinned commit and the version database out of the
worktree. The fixtures below model both files so a heal cannot pass by curing
one of them.

Everything here drives the real functions in build.py against throwaway git
repositories: an "upstream" that advances past a clone, exactly as vcpkg's
registry advances past a container image. No network, no vcpkg install.

Run: python3 scripts/test/vcpkg_baseline_test.py
"""

import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

PASSED = 0
FAILED = 0


def load_build_module():
    """Import build.py by path - it is a script, not an installed module."""
    spec = importlib.util.spec_from_file_location("vayu_build", REPO_ROOT / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pass_(name: str) -> None:
    global PASSED
    print(f"  ok - {name}")
    PASSED += 1


def fail(name: str, detail: str) -> None:
    global FAILED
    print(f"  FAIL - {name}")
    print(f"         {detail}")
    FAILED += 1


def check(name: str, condition: bool, detail: str = "") -> None:
    pass_(name) if condition else fail(name, detail)


def git(repo: Path, *args: str) -> str:
    """Run git in repo with an identity, so commits work on a bare CI box."""
    result = subprocess.run(
        ["git", "-C", str(repo),
         "-c", "user.name=vayu-test", "-c", "user.email=test@vayu.invalid",
         "-c", "commit.gpgsign=false", *args],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


# The two files vcpkg reads, and it reads them from different places: the
# baseline map out of the pinned commit, the per-port version database out of
# the worktree. The fixtures model both, because healing only one is the bug.
BASELINE_MAP = Path("versions") / "baseline.json"
VERSION_DB = Path("versions") / "c-" / "curl.json"


def make_registry(root: Path) -> Path:
    """A stand-in vcpkg registry with one commit, ready to be cloned."""
    registry = root / "registry"
    (registry / VERSION_DB.parent).mkdir(parents=True)
    (registry / BASELINE_MAP).write_text(json.dumps({"default": {"curl": {"baseline": "8.0.0"}}}))
    (registry / VERSION_DB).write_text(json.dumps({"versions": ["8.0.0"]}))
    git(registry.parent, "init", "--quiet", str(registry))
    git(registry, "add", "-A")
    git(registry, "commit", "--quiet", "-m", "initial")
    return registry


def advance_registry(registry: Path, version: str) -> str:
    """Publish a new curl version upstream; return the sha to pin as baseline."""
    known = json.loads((registry / VERSION_DB).read_text())["versions"]
    (registry / VERSION_DB).write_text(json.dumps({"versions": [version] + known}))
    (registry / BASELINE_MAP).write_text(json.dumps({"default": {"curl": {"baseline": version}}}))
    git(registry, "add", "-A")
    git(registry, "commit", "--quiet", "-m", f"curl {version}")
    return git(registry, "rev-parse", "HEAD")


def worktree_knows(clone: Path, version: str) -> bool:
    """Does the *checked-out* version database carry this version?

    This is the assertion that separates a real heal from a fetch: after a
    fetch alone the commit is reachable and this file is still the old one,
    which is the "no version database entry for curl at <version>" failure.
    """
    try:
        return version in json.loads((clone / VERSION_DB).read_text())["versions"]
    except (OSError, ValueError, KeyError):
        return False


def make_engine_dir(root: Path, baseline) -> Path:
    """An engine/ whose vcpkg.json pins `baseline` (omitted when None)."""
    engine = root / "engine"
    engine.mkdir(parents=True, exist_ok=True)
    manifest = {"name": "vayu-engine", "dependencies": ["curl"]}
    if baseline is not None:
        manifest["builtin-baseline"] = baseline
    (engine / "vcpkg.json").write_text(json.dumps(manifest))
    return engine


def heal(build, vcpkg_root, engine_dir):
    """Call the self-heal, returning (result, printed output)."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = build.heal_stale_vcpkg_baseline(str(vcpkg_root), engine_dir)
    return result, buffer.getvalue()


def test_stale_clone_heals(build, root: Path) -> None:
    """The observed case: a clone made before the pin moved."""
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    baseline = advance_registry(registry, "8.21.0")
    engine = make_engine_dir(root, baseline)

    check("a clone predating the pin cannot resolve the pinned version",
          not worktree_knows(clone, "8.21.0"), "fixture is not actually stale")

    result, output = heal(build, clone, engine)
    check("a stale clone is brought forward to the baseline",
          result and worktree_knows(clone, "8.21.0"),
          f"returned {result}; output: {output.strip()}")


def test_fetched_but_unmoved_clone_heals(build, root: Path) -> None:
    """The correction on issue #692: fetching is only half the cure.

    Here the baseline commit is already in the object store - someone ran the
    `git fetch` the first error suggested - and the worktree is still old. A
    heal that probes only for the commit calls this healthy, and vcpkg then
    fails with "no version database entry for curl at 8.21.0".
    """
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    baseline = advance_registry(registry, "8.21.0")
    git(clone, "fetch", "--quiet", "origin")
    engine = make_engine_dir(root, baseline)

    check("the fetched clone has the baseline commit but not the version db",
          git(clone, "cat-file", "-t", baseline) == "commit" and not worktree_knows(clone, "8.21.0"),
          "fixture does not model the fetched-but-unmoved state")

    result, output = heal(build, clone, engine)
    check("a fetched-but-unmoved worktree is still moved forward",
          result and worktree_knows(clone, "8.21.0"),
          f"returned {result}; output: {output.strip()}")


def test_shallow_clone_heals(build, root: Path) -> None:
    """`--setup` bootstraps vcpkg with --depth=1, so shallow is a real shape.

    The pin here is *behind* the upstream tip, which is the shape a real bump
    has by the time anyone builds against it: the heal has to reach a commit
    that is neither the tip nor inside the clone's shallow boundary.
    """
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(
        ["git", "clone", "--quiet", "--depth=1", f"file://{registry}", str(clone)],
        check=True,
    )
    baseline = advance_registry(registry, "8.21.0")
    advance_registry(registry, "8.22.0")
    engine = make_engine_dir(root, baseline)

    result, output = heal(build, clone, engine)
    check("a shallow clone is healed too", result and worktree_knows(clone, "8.21.0"),
          f"returned {result}; output: {output.strip()}")


def test_shallow_clone_at_the_tip_heals(build, root: Path) -> None:
    """A fresh `--setup` bootstrap: `git clone --depth=1`, cut at the tip.

    Its worktree already contains the pinned version - the pin is older than
    the tip - but the baseline *commit* is behind the shallow boundary, so
    vcpkg cannot read the baseline map out of it and no fetch of new commits
    will ever bring it in. Only deepening does.
    """
    registry = make_registry(root)
    baseline = advance_registry(registry, "8.21.0")
    advance_registry(registry, "8.22.0")
    clone = root / "vcpkg"
    subprocess.run(
        ["git", "clone", "--quiet", "--depth=1", f"file://{registry}", str(clone)],
        check=True,
    )
    engine = make_engine_dir(root, baseline)

    check("the bootstrap clone is missing the pinned commit",
          subprocess.run(["git", "-C", str(clone), "cat-file", "-e", baseline],
                         capture_output=True).returncode != 0,
          "fixture does not model a shallow boundary")

    result, output = heal(build, clone, engine)
    check("a shallow clone cut at the tip is deepened to reach the pin",
          result and git(clone, "cat-file", "-t", baseline) == "commit",
          f"returned {result}; output: {output.strip()}")


def test_detached_clone_lands_on_the_pin(build, root: Path) -> None:
    """A detached checkout has no branch to fast-forward - land on the pin."""
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    git(clone, "checkout", "--quiet", "--detach", "HEAD")
    baseline = advance_registry(registry, "8.21.0")
    advance_registry(registry, "8.22.0")
    engine = make_engine_dir(root, baseline)

    result, output = heal(build, clone, engine)
    check("a detached clone is checked out at the pinned commit",
          result and git(clone, "rev-parse", "HEAD") == baseline,
          f"returned {result}; HEAD {git(clone, 'rev-parse', 'HEAD')}; output: {output.strip()}")
    check("landing on the pin does not overshoot into a newer registry",
          worktree_knows(clone, "8.21.0") and not worktree_knows(clone, "8.22.0"),
          "the worktree moved past the pinned commit")


def test_current_clone_is_left_alone(build, root: Path) -> None:
    """A clone that already carries the pin must not pay for an update.

    Asserted by deleting the remote's directory first: any fetch would fail, so
    a clean pass proves the probe short-circuited.
    """
    registry = make_registry(root)
    baseline = advance_registry(registry, "8.21.0")
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    engine = make_engine_dir(root, baseline)
    shutil.rmtree(registry)

    result, output = heal(build, clone, engine)
    check("a current clone passes without touching the network",
          result and output.strip() == "", f"returned {result}; output: {output.strip()}")


def test_dirty_clone_is_not_touched(build, root: Path) -> None:
    """Someone's edited registry is theirs. Refuse, say why, and name the cure.

    git would refuse to clobber the edit on its own; what it would not do is
    say which of the several things that can go wrong here went wrong. The
    named reason is the whole contribution of the guard, so it is asserted.
    """
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    baseline = advance_registry(registry, "8.21.0")
    engine = make_engine_dir(root, baseline)
    (clone / BASELINE_MAP).write_text('{"default":{"curl":{"baseline":"local-edit"}}}')

    result, output = heal(build, clone, engine)
    check("a dirty checkout reports failure rather than moving", result is False,
          f"returned {result}")
    check("the local modification survives",
          "local-edit" in (clone / BASELINE_MAP).read_text(), "the edit was overwritten")
    check("the refusal says the checkout is modified, not just that it failed",
          "local modifications" in output, f"output: {output.strip()}")
    check("the refusal names the manual cure",
          f'git -C "{clone}" pull --ff-only origin master' in output, f"output: {output.strip()}")


def test_unhealable_clone_names_the_cure(build, root: Path) -> None:
    """No remote to update from: fail loudly, naming the command."""
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    git(clone, "remote", "remove", "origin")
    baseline = advance_registry(registry, "8.21.0")
    engine = make_engine_dir(root, baseline)

    result, output = heal(build, clone, engine)
    check("an unhealable clone reports failure", result is False, f"returned {result}")
    check("the failure names `git -C <root> pull`",
          f'git -C "{clone}" pull --ff-only origin master' in output, f"output: {output.strip()}")


def test_non_git_vcpkg_root_is_skipped(build, root: Path) -> None:
    """The vcpkg bundled with VS Build Tools is not something to fetch."""
    plain = root / "vcpkg-not-a-checkout"
    plain.mkdir()
    engine = make_engine_dir(root, "0" * 40)

    result, output = heal(build, plain, engine)
    check("a vcpkg root that is not a git checkout is skipped silently",
          result and output.strip() == "", f"returned {result}; output: {output.strip()}")


def test_manifest_without_baseline_is_skipped(build, root: Path) -> None:
    """Nothing to probe against - and nothing to complain about."""
    registry = make_registry(root)
    clone = root / "vcpkg"
    subprocess.run(["git", "clone", "--quiet", str(registry), str(clone)], check=True)
    engine = make_engine_dir(root, None)

    result, output = heal(build, clone, engine)
    check("a manifest with no builtin-baseline is skipped silently",
          result and output.strip() == "", f"returned {result}; output: {output.strip()}")


def test_error_translation(build) -> None:
    """The path where healing was impossible: the error must name its cure.

    Both wordings are verbatim from a real stale clone - the first from the
    tool version in issue #692, the second from the one in the cloud container
    that reproduced it. A signature matching only one of them would leave half
    the installed tool versions untranslated.
    """
    wordings = {
        "the git-level wording": (
            "error: fatal: path 'versions/baseline.json' exists on disk, but not in "
            "'94a541197763a4f449a1b91478df48c0584a6256'\n"
            "  while loading baseline version for curl\n"
        ),
        "the wrapped wording": (
            "error: while checking out baseline from commit "
            "'94a541197763a4f449a1b91478df48c0584a6256', failed to `git show` "
            "versions/baseline.json. This may be fixed by fetching commits with `git fetch`.\n"
            "while loading baseline version for curl\n"
        ),
        # The second failure, reached only after a fetch: commit present,
        # worktree behind. Without this signature the half-healed clone - the
        # state the first error's own advice leaves you in - goes untranslated.
        "the stale-worktree wording": (
            "error: no version database entry for cpp-httplib at 0.53.0.\n"
            "Available versions:\n  0.52.0\n  0.51.0\n"
        ),
    }
    for label, vcpkg_error in wordings.items():
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            build.explain_vcpkg_failure(vcpkg_error, "/opt/vcpkg")
        translated = buffer.getvalue()
        check(f"{label} is translated",
              'git -C "/opt/vcpkg" pull --ff-only origin master' in translated,
              f"output: {translated.strip()}")

    vcpkg_error = wordings["the git-level wording"]

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        build.explain_vcpkg_failure("ninja: build stopped: subcommand failed.\n", "/opt/vcpkg")
    check("an unrelated failure is not translated", buffer.getvalue().strip() == "",
          f"output: {buffer.getvalue().strip()}")

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        build.explain_vcpkg_failure(vcpkg_error, None)
    check("an unresolved vcpkg root still names the variable",
          "$VCPKG_ROOT" in buffer.getvalue(), f"output: {buffer.getvalue().strip()}")


def main() -> int:
    if shutil.which("git") is None:
        print("git is required to run this suite")
        return 1

    build = load_build_module()
    print("build.py stale-vcpkg-baseline self-heal")
    print()

    # Each case gets its own temporary tree: they all create a registry and a
    # clone at fixed names, and a leaked one would make the next case lie.
    per_tree = [
        test_stale_clone_heals,
        test_fetched_but_unmoved_clone_heals,
        test_shallow_clone_heals,
        test_shallow_clone_at_the_tip_heals,
        test_detached_clone_lands_on_the_pin,
        test_current_clone_is_left_alone,
        test_dirty_clone_is_not_touched,
        test_unhealable_clone_names_the_cure,
        test_non_git_vcpkg_root_is_skipped,
        test_manifest_without_baseline_is_skipped,
    ]
    for case in per_tree:
        with tempfile.TemporaryDirectory() as tmp:
            case(build, Path(tmp))

    test_error_translation(build)

    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    if PASSED == 0:
        print("  no assertions ran - the suite proved nothing")
        return 1
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
