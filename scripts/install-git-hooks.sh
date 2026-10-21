#!/bin/bash

# Installs the repository's git hooks as symlinks, so a pull keeps them current:
#   pre-commit - clang-format 19 over staged engine sources (under a second)
#   pre-push   - clang-tidy 22 over the C++ files a push changes (minutes)

# Get the root of the git repository
REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_DIR="$REPO_ROOT/.git/hooks"

# Ensure hooks directory exists
mkdir -p "$HOOK_DIR"

for HOOK in pre-commit pre-push; do
    echo "Installing $HOOK hook..."
    ln -sf "$REPO_ROOT/scripts/$HOOK" "$HOOK_DIR/$HOOK"
    chmod +x "$REPO_ROOT/scripts/$HOOK"
done

echo "Git hooks installed successfully."
