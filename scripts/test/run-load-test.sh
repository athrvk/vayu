#!/bin/bash

# Exit on error
set -e

# Default to load-test-example.json if no argument provided
TEST_FILE="${1:-load-test-example.json}"

# Resolve file path
if [ ! -f "$TEST_FILE" ]; then
    if [ -f "scripts/test/$TEST_FILE" ]; then
        TEST_FILE="scripts/test/$TEST_FILE"
    elif [ -f "$TEST_FILE" ]; then
        # Already absolute or relative path
        :
    else
        echo "Error: Test file '$TEST_FILE' not found."
        exit 1
    fi
fi

# Get absolute path for the test file
TEST_FILE_ABS=$(cd "$(dirname "$TEST_FILE")" && pwd)/$(basename "$TEST_FILE")

# Navigate to project root (assuming script is in scripts/ or root)
if [ -d "engine" ]; then
    PROJECT_ROOT="."
elif [ -d "../engine" ]; then
    PROJECT_ROOT=".."
else
    echo "Error: Could not find project root (engine directory)."
    exit 1
fi

cd "$PROJECT_ROOT"

# Ensure CLI is built
if [ ! -f "engine/build/vayu-cli" ]; then
    echo "Building vayu-cli..."
    cmake --build engine/build --target vayu-cli > /dev/null
fi

echo "Starting load test from $TEST_FILE..."
# Run the CLI and capture output
# We use a temporary file to capture output while also showing it if needed, 
# but here we just capture it to variable to parse Run ID.
OUTPUT=$(./engine/build/vayu-cli run "$TEST_FILE_ABS")
echo "$OUTPUT"

# Extract Run ID
# Output format: "Run ID: run_1767359116299"
RUN_ID=$(echo "$OUTPUT" | grep "Run ID:" | awk '{print $3}')

if [ -z "$RUN_ID" ]; then
    echo "Error: Could not extract Run ID. Is the daemon running?"
    exit 1
fi

DAEMON_URL="http://127.0.0.1:9876"
STATS_URL="$DAEMON_URL/stats/$RUN_ID"

echo ""
echo "Streaming results from $STATS_URL..."
echo "----------------------------------------"

# Function to format JSON output
format_json() {
    if command -v jq >/dev/null 2>&1; then
        jq -c '.'
    else
        cat
    fi
}

# Track if we've seen the complete event
COMPLETE_SEEN=false

# Stream the SSE output - we need to keep reading until we see the complete event
curl -N -s "$STATS_URL" 2>/dev/null | while IFS= read -r line; do
    # Handle SSE lines
    if [[ "$line" == "event: complete" ]]; then
        COMPLETE_SEEN=true
        echo ""
        echo "Test Completed!"
        # Continue reading to get the final data line
        continue
    elif [[ "$line" == "data: "* ]]; then
        JSON_DATA="${line#data: }"
        
        # Format and display the JSON data
        echo "$JSON_DATA" | format_json
        
        # If we just saw a complete event and printed the final data, we can exit
        if [ "$COMPLETE_SEEN" = true ]; then
            echo "----------------------------------------"
            exit 0
        fi
    fi
done

echo "----------------------------------------"
echo "Stream ended."
