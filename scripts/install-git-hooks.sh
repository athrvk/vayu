#!/bin/bash

# Get the root of the git repository
REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_DIR="$REPO_ROOT/.git/hooks"

echo "Installing pre-commit hook..."

# Ensure hooks directory exists
mkdir -p "$HOOK_DIR"

# Create symlink
ln -sf "$REPO_ROOT/scripts/pre-commit" "$HOOK_DIR/pre-commit"
chmod +x "$HOOK_DIR/pre-commit"
chmod +x "$REPO_ROOT/scripts/pre-commit"

echo "Pre-commit hook installed successfully."
