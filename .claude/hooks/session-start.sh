#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# --setup carries the stale-vcpkg-baseline self-heal (issue #692): a container
# image whose vcpkg clone predates the pinned baseline is brought forward before
# dependencies are installed. Do not re-probe for it here - one implementation,
# and it is the one every other entry point uses too.
python3 "$PROJECT_DIR/build.py" --setup

# Stdout of a SessionStart hook reaches the session as context, so say what the
# setup above did and did not do. Cloud sessions only (the guard at the top):
# a local checkout has its own state, and this repo is OSS, so the note lives
# here rather than in CLAUDE.md, where every contributor would read it.
engine_bin="$(find "$PROJECT_DIR/engine/build" -maxdepth 2 -name vayu-engine -type f 2>/dev/null | head -n 1)"
if [ -n "$engine_bin" ]; then
  engine_state="built at ${engine_bin#"$PROJECT_DIR"/}"
else
  engine_state="NOT built (engine/build is absent)"
fi
cat <<NOTE

Cloud session environment (from .claude/hooks/session-start.sh):
- Already done by 'build.py --setup': system packages, vcpkg dependencies, app
  node_modules, git pre-commit hook. Do not re-run --setup or reinstall them.
- The engine is ${engine_state}.
  When you need it: 'ninja -C engine/build vayu-engine' once configured, else
  'python build.py -e' (add -t for tests). Skip building for docs-only or
  app-only changes.
NOTE
