#!/bin/bash
# Linux .deb package post-installation script
# This script runs after the package is installed

set -e

# Clean up any stale lock files from previous installations
LOCK_FILE="$HOME/.config/vayu/vayu.lock"

if [ -f "$LOCK_FILE" ]; then
    # Check if the PID in the lock file is still running
    PID=$(cat "$LOCK_FILE" 2>/dev/null | tr -d '\n' || echo "")
    
    if [ -n "$PID" ] && [ "$PID" -eq "$PID" ] 2>/dev/null; then
        # Check if process is running
        if ! kill -0 "$PID" 2>/dev/null; then
            # Process is not running, remove stale lock file
            rm -f "$LOCK_FILE"
            echo "Removed stale lock file from previous installation"
        fi
    else
        # Invalid PID, remove the lock file
        rm -f "$LOCK_FILE"
        echo "Removed invalid lock file"
    fi
fi

exit 0
