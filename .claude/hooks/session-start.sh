#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

echo "==> [vayu] Installing app dependencies..."
cd "$PROJECT_DIR/app"
pnpm install

echo "==> [vayu] App dependencies installed."

# Set up vcpkg for C++ engine if not already available
if ! command -v vcpkg &>/dev/null && [ -z "${VCPKG_ROOT:-}" ]; then
  VCPKG_DIR="$HOME/.vcpkg"
  if [ ! -d "$VCPKG_DIR" ]; then
    echo "==> [vayu] Bootstrapping vcpkg..."
    git clone https://github.com/microsoft/vcpkg.git "$VCPKG_DIR" --depth=1 --quiet
    "$VCPKG_DIR/bootstrap-vcpkg.sh" -disableMetrics
  fi
  export VCPKG_ROOT="$VCPKG_DIR"
  echo "export VCPKG_ROOT=\"$VCPKG_DIR\"" >> "$CLAUDE_ENV_FILE"
  echo "export PATH=\"$VCPKG_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  echo "==> [vayu] vcpkg ready at $VCPKG_DIR"
fi

echo "==> [vayu] Environment setup complete."
