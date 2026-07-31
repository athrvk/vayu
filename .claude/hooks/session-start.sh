#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# `build.py --setup` ends in `pnpm install`, and pnpm reserializes the manifests
# it reads whenever it decides they need normalizing - migrating the deprecated
# pnpm settings out of `app/.npmrc`, folding `allowBuilds` into
# `onlyBuiltDependencies` (or back), reindenting the YAML on the way out. Which
# of those fire depends on the pnpm build the environment happens to ship, so it
# cannot be pinned down from inside the repo: pnpm 10.34.5 leaves the tree clean
# on a cold `--frozen-lockfile` install, yet a session came up with
# `app/pnpm-workspace.yaml` already rewritten and its `allowBuilds` block gone.
#
# The cost is a session that opens with a tracked file modified by nobody, which
# reads as the user's own uncommitted work and invites a commit that quietly
# drops config. Snapshot the manifests, then restore only the ones whose bytes
# setup itself changed - an edit already in the working tree is inside the
# snapshot, so it survives untouched.
MANIFESTS=(
  app/pnpm-workspace.yaml
  app/pnpm-lock.yaml
  app/package.json
  app/.npmrc
)

snapshot_dir="$(mktemp -d)"
trap 'rm -rf "$snapshot_dir"' EXIT

for manifest in "${MANIFESTS[@]}"; do
  [ -f "$PROJECT_DIR/$manifest" ] || continue
  mkdir -p "$snapshot_dir/$(dirname "$manifest")"
  cp -p "$PROJECT_DIR/$manifest" "$snapshot_dir/$manifest"
done

# Restore before propagating a failure: a setup that died midway is exactly when
# a half-rewritten manifest is most likely to be left behind.
setup_status=0
python3 "$PROJECT_DIR/build.py" --setup || setup_status=$?

for manifest in "${MANIFESTS[@]}"; do
  [ -f "$snapshot_dir/$manifest" ] || continue
  [ -f "$PROJECT_DIR/$manifest" ] || continue
  if ! cmp -s "$snapshot_dir/$manifest" "$PROJECT_DIR/$manifest"; then
    cp -p "$snapshot_dir/$manifest" "$PROJECT_DIR/$manifest"
    echo "session-start: restored $manifest (rewritten during setup)" >&2
  fi
done

exit "$setup_status"
