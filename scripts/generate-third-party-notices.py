#!/usr/bin/env python3
"""
Generate THIRD_PARTY_NOTICES.txt: the licence text of every third-party
component Vayu ships (issue #2693).

Three sources, each read from the files the component itself carries:

  1. engine/vendor/*  - every directory, always. A directory with no
     LICENSE*/COPYING* file is an error naming it, so a library cannot be
     added to the shelf without its licence reaching the installer.
  2. vcpkg dependencies - share/<port>/copyright under --vcpkg-share (the
     installed/<triplet>/share directory of the engine's vcpkg tree).
  3. npm - with --app-dir, the closure of app/package.json `dependencies` plus
     the `devDependencies` that app/src or app/electron source imports (Vite
     bundles those into the renderer), read from node_modules.

Sources 2 and 3 are best effort: when their input is absent the section is
omitted and stderr says so, because a developer build has no packaged output
to protect. Output is deterministic (sorted, no timestamps), and identical
licence texts are printed once with the names that share them.

Stdlib only, so it runs under `python -I` before any dependency install.

Usage:
  python scripts/generate-third-party-notices.py --out app/build/THIRD_PARTY_NOTICES.txt \\
      [--repo .] [--vcpkg-share engine/build/vcpkg_installed/x64-linux/share] [--app-dir app]
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

# LICENSE, LICENSE.md, LICENSE.fast-deep-equal, LICENCE, COPYING.txt. The
# prefix is anchored so `licenses/` directories and `*.license` data files do
# not match; the vendored libraries carry several of these side by side.
LICENSE_FILE = re.compile(r"^(licen[sc]e|copying)([._-].*)?$", re.IGNORECASE)

RULE = "=" * 78
THIN_RULE = "-" * 78

# The README convention of the JS shelf: "... version\n**4.17.21**, ...".
README_VERSION = re.compile(r"version\s+\*\*([^*]+)\*\*")

IMPORT_SPECIFIER = re.compile(r"""(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']""")
BUNDLED_SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"}


class MissingLicense(Exception):
    pass


def read_text(path: Path) -> str:
    """Licence text with LF endings and no trailing blank lines."""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")


def license_files(directory: Path) -> List[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        (p for p in directory.iterdir() if p.is_file() and LICENSE_FILE.match(p.name)),
        key=lambda p: p.name,
    )


def group_by_text(entries: List[Tuple[str, str]]) -> str:
    """Render (name, text) pairs, printing each distinct text once."""
    names_by_text: Dict[str, List[str]] = {}
    for name, text in sorted(entries):
        names_by_text.setdefault(text, []).append(name)
    blocks = []
    for text, names in sorted(names_by_text.items(), key=lambda item: item[1]):
        blocks.append(f"{THIN_RULE}\n{', '.join(names)}\n{THIN_RULE}\n\n{text}\n")
    return "\n".join(blocks)


def section(title: str, body: str) -> str:
    return f"{RULE}\n{title}\n{RULE}\n\n{body}\n"


# --- 1. engine/vendor --------------------------------------------------------


def readme_version(directory: Path) -> Optional[str]:
    readme = directory / "README.md"
    if not readme.is_file():
        return None
    match = README_VERSION.search(" ".join(readme.read_text(encoding="utf-8", errors="replace").split()))
    return match.group(1) if match else None


def vendored_section(repo: Path) -> str:
    vendor = repo / "engine" / "vendor"
    directories = sorted(p for p in vendor.iterdir() if p.is_dir()) if vendor.is_dir() else []
    if not directories:
        raise MissingLicense(f"no vendored libraries found under {vendor}")

    blocks = []
    for directory in directories:
        files = license_files(directory)
        if not files:
            raise MissingLicense(
                f"engine/vendor/{directory.name} has no LICENSE* or COPYING* file; "
                "add the library's licence text next to it"
            )
        version = readme_version(directory)
        heading = f"{directory.name} {version}" if version else directory.name
        parts = [f"{THIN_RULE}\n{heading}\n{THIN_RULE}\n"]
        for file in files:
            parts.append(f"[{file.name}]\n\n{read_text(file)}\n")
        blocks.append("\n".join(parts))
    return section("VENDORED LIBRARIES (engine/vendor)", "\n".join(blocks))


# --- 2. vcpkg ----------------------------------------------------------------


def vcpkg_section(share: Path) -> str:
    entries = [
        (port.name, read_text(port / "copyright"))
        for port in sorted(share.iterdir())
        if (port / "copyright").is_file()
    ]
    return section("C++ DEPENDENCIES (vcpkg)", group_by_text(entries))


# --- 3. npm ------------------------------------------------------------------


def bundled_dev_dependencies(app_dir: Path, dev_dependencies: Dict[str, str]) -> List[str]:
    """devDependencies named by non-test source under app/src or app/electron."""
    found = set()
    for root in (app_dir / "src", app_dir / "electron"):
        for path in root.rglob("*") if root.is_dir() else ():
            if path.suffix not in BUNDLED_SOURCE_SUFFIXES or not path.is_file():
                continue
            if is_test_source(path.relative_to(app_dir)):
                continue
            for specifier in IMPORT_SPECIFIER.findall(path.read_text(encoding="utf-8", errors="replace")):
                name = package_name(specifier)
                if name in dev_dependencies:
                    found.add(name)
    return sorted(found)


def is_test_source(relative: Path) -> bool:
    return bool(re.search(r"\.(test|testkit|spec)\.", relative.name)) or "test" in relative.parts


def package_name(specifier: str) -> str:
    parts = specifier.split("/")
    return "/".join(parts[:2]) if specifier.startswith("@") else parts[0]


def resolve_package(name: str, from_dir: Path) -> Optional[Path]:
    """Node's lookup: the nearest enclosing node_modules holding `name`."""
    for parent in [from_dir, *from_dir.parents]:
        if parent.name == "node_modules":
            continue
        candidate = parent / "node_modules" / name
        if candidate.is_dir():
            return candidate.resolve()
    return None


def npm_closure(app_dir: Path, roots: List[str]) -> Tuple[Dict[Path, dict], List[str]]:
    """Every package reachable from `roots` through dependencies, and the roots not installed."""
    packages: Dict[Path, dict] = {}
    missing: List[str] = []
    pending: List[Tuple[str, Path, bool]] = [(name, app_dir, True) for name in roots]
    while pending:
        name, from_dir, is_root = pending.pop()
        directory = resolve_package(name, from_dir)
        if directory is None:
            # An absent optionalDependency is the platform filter working.
            if is_root:
                missing.append(name)
            continue
        if directory in packages:
            continue
        manifest = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        packages[directory] = manifest
        for field in ("dependencies", "optionalDependencies"):
            pending.extend((dep, directory, False) for dep in manifest.get(field, {}))
    return packages, missing


def npm_license_text(directory: Path, package: dict) -> str:
    files = license_files(directory)
    if files:
        return "\n\n".join(read_text(f) for f in files)
    # Some packages publish no licence file; their package.json is then the
    # only statement of the licence there is.
    return f"This package ships no licence file. Declared licence: {package.get('license', 'not declared')}"


def npm_section(app_dir: Path) -> Optional[str]:
    if not (app_dir / "node_modules").is_dir():
        print(f"note: {app_dir / 'node_modules'} not found; npm licences omitted", file=sys.stderr)
        return None
    manifest = json.loads((app_dir / "package.json").read_text(encoding="utf-8"))
    roots = sorted(
        {*manifest.get("dependencies", {}),
         *bundled_dev_dependencies(app_dir, manifest.get("devDependencies", {}))}
    )
    packages, missing = npm_closure(app_dir, roots)
    if missing:
        print(f"note: not installed, omitted from npm licences: {', '.join(missing)}", file=sys.stderr)

    entries = []
    for directory, package in packages.items():
        label = f"{package.get('name', directory.name)}@{package.get('version', '?')}"
        entries.append((label, npm_license_text(directory, package)))
    return section("JAVASCRIPT DEPENDENCIES (npm)", group_by_text(entries))


# --- main --------------------------------------------------------------------


HEADER = """\
THIRD-PARTY NOTICES

Vayu includes the third-party software listed below. Each component is
distributed under its own licence, reproduced here as its authors published it.
"""


def sections(args: argparse.Namespace, repo: Path) -> Iterator[str]:
    yield vendored_section(repo)

    if args.vcpkg_share and args.vcpkg_share.is_dir():
        yield vcpkg_section(args.vcpkg_share)
    else:
        print(f"note: vcpkg share directory {args.vcpkg_share or '(not given)'} unavailable; "
              "C++ dependency licences omitted", file=sys.stderr)

    if args.app_dir:
        npm = npm_section(args.app_dir)
        if npm:
            yield npm


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, required=True, help="file to write")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="repository root (default: parent of scripts/)")
    parser.add_argument("--vcpkg-share", type=Path,
                        help="the vcpkg installed/<triplet>/share directory")
    parser.add_argument("--app-dir", type=Path, help="the app directory, for npm licences")
    args = parser.parse_args()

    try:
        body = "\n".join(sections(args, args.repo))
    except MissingLicense as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as out:
        out.write(f"{HEADER}\n{body}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
