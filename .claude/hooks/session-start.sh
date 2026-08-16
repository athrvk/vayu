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
