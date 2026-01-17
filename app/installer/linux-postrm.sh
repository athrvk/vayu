#!/bin/bash
# Linux .deb package post-removal script
# This script runs after the package is removed

set -e

# Clean up lock file if user chooses to remove configuration
# Note: This only removes the lock file, not user data
# User data removal is handled separately if user chooses to purge

LOCK_FILE="$HOME/.config/vayu/vayu.lock"

if [ -f "$LOCK_FILE" ]; then
    # Remove lock file to prevent issues on reinstall
    rm -f "$LOCK_FILE"
    echo "Removed lock file"
fi

exit 0
