"""Serve the macOS installer from the docs site, off the repo's real script.

The command a Mac user copies used to point at raw.githubusercontent.com, which
spends most of its 92 characters on `owner/repo/branch`. Served from this site
it is a third shorter and reads as the product's own URL:

    bash -c "$(curl -fsSL https://athrvk.github.io/vayu/install.sh)"

`install.sh` stays at the repo root, because that is where the things that test
it look: `shellcheck install.sh` in .github/workflows/pr-tests.yml, and
scripts/test/install_test.sh. MkDocs can only read files under `docs_dir`, so
the obvious alternative - a copy at docs/install.sh - would be a *second copy of
an executable script*, free to drift from the tested one with nothing failing.
This hook registers the root script as a generated file instead, the same trick
hooks/brand_assets.py uses for the icon, so there is exactly one install.sh and
the published one is it.

That buys one obligation: `install.sh` must stay in the `paths:` filters of
.github/workflows/docs.yml (push *and* pull_request). Miss it and editing the
installer no longer redeploys the site, so the published copy silently falls
behind master - a failure mode the raw.githubusercontent URL did not have,
since it served the branch directly. The old URL still works, and anything
already pointing at it keeps working.

Wired up via `hooks:` in mkdocs.yml. If a future MkDocs drops hook support, the
fallback is a copy at docs/install.sh plus a CI check that it matches the root
one - delete this file, no other config changes.
"""

from __future__ import annotations

from pathlib import Path

from mkdocs.structure.files import File, Files

# Resolved from this file rather than the working directory, so it holds however
# mkdocs was invoked.
REPO_ROOT = Path(__file__).resolve().parents[2]

SCRIPT_SOURCE = REPO_ROOT / "install.sh"

# Site root, so the published URL is <site_url>install.sh and nothing longer.
# The install commands in README.md and docs/index.md hardcode it.
SCRIPT_DEST = "install.sh"


def on_files(files: Files, config) -> Files:
    if not SCRIPT_SOURCE.is_file():
        # Loud on purpose. A missing script would otherwise publish as a 404 on
        # the one URL the install instructions tell people to pipe into bash.
        raise FileNotFoundError(
            f"docs site installer missing: {SCRIPT_SOURCE}. "
            "It is the script README.md and docs/index.md tell macOS users to run."
        )

    files.append(
        File.generated(config, SCRIPT_DEST, abs_src_path=str(SCRIPT_SOURCE))
    )
    return files
