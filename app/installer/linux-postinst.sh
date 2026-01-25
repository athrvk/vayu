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
        # Check if process is running AND is vayu-engine
        if ps -p "$PID" -o comm= 2>/dev/null | grep -q "^vayu-engine$"; then
            # Vayu engine is actually running, don't remove lock
            echo "Vayu engine is running with PID $PID"
        else
            # PID doesn't exist or belongs to different process
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
