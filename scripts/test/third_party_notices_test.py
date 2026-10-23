#!/usr/bin/env python3
"""
THIRD_PARTY_NOTICES generation (issue #2693).

The installers ship a notices file built from the licence of every vendored
library. What keeps it complete is that the generator derives its list from
engine/vendor/* and refuses a directory with no licence file, so a library
added to the shelf either carries its licence into the installer or fails this
suite and the build.

Run: python3 scripts/test/third_party_notices_test.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATOR = REPO_ROOT / "scripts" / "generate-third-party-notices.py"
VENDOR = REPO_ROOT / "engine" / "vendor"

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        print(f"  ok - {name}")
        PASSED += 1
    else:
        print(f"  FAIL - {name}")
        print(f"         {detail}")
        FAILED += 1


def licence_files(directory: Path) -> List[Path]:
    return sorted([*directory.glob("LICENSE*"), *directory.glob("COPYING*")])


def generate(out: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(GENERATOR), "--out", str(out), *args],
        capture_output=True, text=True,
    )


def normalised(path: Path) -> str:
    """The text as the generator prints it: LF endings, no outer blank lines."""
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").strip("\n")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fake_repo(root: Path, libraries: dict) -> Path:
    """A minimal repo: engine/vendor/<name>/ with the given files."""
    for name, files in libraries.items():
        (root / "engine" / "vendor" / name).mkdir(parents=True)
        for filename, text in files.items():
            write(root / "engine" / "vendor" / name / filename, text)
    return root


def test_every_vendor_dir_has_a_licence() -> None:
    directories = sorted(p for p in VENDOR.iterdir() if p.is_dir())
    check("scanned a non-empty set of vendor dirs", len(directories) > 0, f"{VENDOR} has no directories")
    bare = [d.name for d in directories if not licence_files(d)]
    check("every engine/vendor dir has a LICENSE* or COPYING* file", not bare,
          f"no licence file in: {', '.join(bare)}")


def test_generator_covers_the_real_shelf(tmp: Path) -> None:
    out = tmp / "real.txt"
    result = generate(out, "--repo", str(REPO_ROOT))
    check("generator succeeds on the real repo", result.returncode == 0, result.stderr)
    if result.returncode != 0:
        return
    notices = out.read_text(encoding="utf-8")

    directories = sorted(p for p in VENDOR.iterdir() if p.is_dir())
    missing_names = [d.name for d in directories if d.name not in notices]
    check("output names every vendor dir", not missing_names, f"missing: {missing_names}")

    missing_texts = [
        f"{d.name}/{f.name}"
        for d in directories for f in licence_files(d)
        if normalised(f) not in notices
    ]
    check("output carries the full text of every licence file", not missing_texts,
          f"missing: {missing_texts}")


def test_missing_licence_fails_naming_the_dir(tmp: Path) -> None:
    good = fake_repo(tmp / "good", {"alpha": {"LICENSE": "ALPHA TERMS"}})
    check("a tree whose vendor dirs all carry a licence succeeds",
          generate(tmp / "good.txt", "--repo", str(good)).returncode == 0)

    bad = fake_repo(tmp / "bad", {
        "alpha": {"LICENSE": "ALPHA TERMS"},
        "bravo": {"README.md": "no licence here", "bravo.min.js": ""},
    })
    result = generate(tmp / "bad.txt", "--repo", str(bad))
    check("a vendor dir without a licence file fails the generator", result.returncode != 0,
          f"exit {result.returncode}")
    check("the failure names the directory", "bravo" in result.stderr, result.stderr)


def test_extra_and_copying_files_are_all_included(tmp: Path) -> None:
    repo = fake_repo(tmp / "repo", {
        "multi": {"LICENSE": "MAIN TERMS", "LICENSE.dep": "DEP TERMS"},
        "copying": {"COPYING.txt": "COPYING TERMS", "LICENSE.txt": "LICENSE TXT TERMS"},
    })
    out = tmp / "multi.txt"
    generate(out, "--repo", str(repo))
    notices = out.read_text(encoding="utf-8")
    for marker in ("MAIN TERMS", "DEP TERMS", "COPYING TERMS", "LICENSE TXT TERMS"):
        check(f"{marker} is included", marker in notices)


def test_vcpkg_section(tmp: Path) -> None:
    repo = fake_repo(tmp / "repo", {"alpha": {"LICENSE": "ALPHA TERMS"}})
    share = tmp / "share"
    write(share / "zlib" / "copyright", "SHARED TERMS\n")
    write(share / "abseil" / "copyright", "SHARED TERMS\r\n")
    write(share / "curl" / "copyright", "CURL TERMS\n")
    write(share / "pkgconfig" / "zlib.pc", "not a licence")

    out = tmp / "vcpkg.txt"
    result = generate(out, "--repo", str(repo), "--vcpkg-share", str(share))
    notices = out.read_text(encoding="utf-8")
    check("vcpkg copyright files are included", result.returncode == 0 and "CURL TERMS" in notices,
          result.stderr)
    check("identical texts are printed once", notices.count("SHARED TERMS") == 1,
          f"printed {notices.count('SHARED TERMS')} times")
    check("the shared text lists both packages", "abseil, zlib" in notices)

    absent = generate(tmp / "absent.txt", "--repo", str(repo), "--vcpkg-share", str(tmp / "nope"))
    check("a missing vcpkg tree does not fail", absent.returncode == 0, absent.stderr)
    check("a missing vcpkg tree is said on stderr", "vcpkg" in absent.stderr, absent.stderr)


def test_npm_section(tmp: Path) -> None:
    repo = fake_repo(tmp / "repo", {"alpha": {"LICENSE": "ALPHA TERMS"}})
    app = tmp / "repo" / "app"
    modules = app / "node_modules"
    write(app / "package.json", json.dumps({
        "dependencies": {"prod": "1.0.0"},
        "devDependencies": {"bundled": "1.0.0", "toolonly": "1.0.0", "testonly": "1.0.0"},
    }))
    write(modules / "prod" / "package.json", json.dumps(
        {"name": "prod", "version": "1.0.0", "dependencies": {"transitive": "1.0.0"}}))
    write(modules / "prod" / "LICENSE", "PROD TERMS")
    write(modules / "transitive" / "package.json", json.dumps({"name": "transitive", "version": "2.0.0"}))
    write(modules / "transitive" / "LICENSE.md", "TRANSITIVE TERMS")
    write(modules / "bundled" / "package.json", json.dumps({"name": "bundled", "version": "3.0.0"}))
    write(modules / "bundled" / "LICENSE", "BUNDLED TERMS")
    write(modules / "toolonly" / "package.json", json.dumps({"name": "toolonly", "version": "1.0.0"}))
    write(modules / "toolonly" / "LICENSE", "TOOLONLY TERMS")
    write(modules / "testonly" / "package.json", json.dumps({"name": "testonly", "version": "1.0.0"}))
    write(modules / "testonly" / "LICENSE", "TESTONLY TERMS")
    write(app / "src" / "view.tsx", 'import { x } from "bundled";\n')
    write(app / "src" / "view.test.tsx", 'import { y } from "testonly";\n')

    out = tmp / "npm.txt"
    result = generate(out, "--repo", str(repo), "--app-dir", str(app))
    notices = out.read_text(encoding="utf-8")
    check("npm run succeeds", result.returncode == 0, result.stderr)
    check("dependencies are included", "PROD TERMS" in notices)
    check("transitive dependencies are included", "TRANSITIVE TERMS" in notices)
    check("a devDependency imported by shipped source is included", "BUNDLED TERMS" in notices)
    check("a devDependency only tooling uses is left out", "TOOLONLY TERMS" not in notices)
    check("a devDependency only tests import is left out", "TESTONLY TERMS" not in notices)

    no_modules = generate(tmp / "none.txt", "--repo", str(repo), "--app-dir", str(tmp / "empty-app"))
    check("an app without node_modules does not fail", no_modules.returncode == 0, no_modules.stderr)
    check("the missing node_modules is said on stderr", "node_modules" in no_modules.stderr,
          no_modules.stderr)


def main() -> int:
    print("THIRD_PARTY_NOTICES generator")
    print()
    test_every_vendor_dir_has_a_licence()
    cases = [
        test_generator_covers_the_real_shelf,
        test_missing_licence_fails_naming_the_dir,
        test_extra_and_copying_files_are_all_included,
        test_vcpkg_section,
        test_npm_section,
    ]
    for case in cases:
        with tempfile.TemporaryDirectory() as tmp:
            case(Path(tmp))

    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    if PASSED == 0:
        print("  no assertions ran - the suite proved nothing")
        return 1
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
