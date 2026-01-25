#!/bin/bash
# Linux .deb package pre-removal script
# This script runs before the package is removed

set -e

# Kill any running engine processes before uninstall
# This ensures clean uninstallation
if pgrep -x "vayu-engine" > /dev/null; then
    echo "Stopping Vayu engine processes..."
    pkill -x "vayu-engine" || true
    sleep 1
fi

exit 0
