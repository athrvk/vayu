"""Feed the docs site its brand assets from the repo's real icon set.

MkDocs can only read files under `docs_dir`, so the favicon/logo would normally
have to be copied into `docs/images/` - a second copy of an asset whose source of
truth is `shared/icon_png/` (the set `setup_icons()` in build.py hands to the
installers). Regenerating the brand icon would then silently leave the docs site
on the old one.

This hook registers the shared PNG as a generated file at the path
`theme.favicon` / `theme.logo` already point to, so the build reads
`shared/icon_png/` directly and there is nothing to keep in step. It applies to
`mkdocs serve` as well as `mkdocs build`, since both consume the same file
collection.

Wired up via `hooks:` in mkdocs.yml. If a future MkDocs drops hook support, the
fallback is the copy this replaced: put the PNG at docs/images/vayu-icon.png and
delete this file - no other config changes.
"""

from __future__ import annotations

from pathlib import Path

from mkdocs.structure.files import File, Files

# Resolved from this file rather than the working directory, so it holds however
# mkdocs was invoked.
REPO_ROOT = Path(__file__).resolve().parent.parent

# The 256px PNG: large enough for a retina header logo, and every browser scales
# it down for the tab. The .ico set exists too but buys nothing here - PNG
# favicons have been universally supported for years.
ICON_SOURCE = REPO_ROOT / "shared" / "icon_png" / "vayu_icon_256x256.png"

# Must match `theme.favicon` and `theme.logo` in mkdocs.yml.
ICON_DEST = "images/vayu-icon.png"


def on_files(files: Files, config) -> Files:
    if not ICON_SOURCE.is_file():
        # Loud on purpose. A missing icon would otherwise surface as a silently
        # broken favicon on the published site, long after the build passed.
        raise FileNotFoundError(
            f"docs site brand asset missing: {ICON_SOURCE}. "
            "It is the source the installers use too - see setup_icons in build.py."
        )

    files.append(
        File.generated(config, ICON_DEST, abs_src_path=str(ICON_SOURCE))
    )
    return files
