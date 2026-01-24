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
elif [ -d "../../engine" ]; then
    PROJECT_ROOT="../.."
else
    echo "Error: Could not find project root (engine directory)."
    exit 1
fi

cd "$PROJECT_ROOT"

# Find CLI binary (check prod build first, then dev build)
if [ -f "engine/build-release/vayu-cli" ]; then
    CLI_PATH="engine/build-release/vayu-cli"
elif [ -f "engine/build/vayu-cli" ]; then
    CLI_PATH="engine/build/vayu-cli"
else
    echo "Error: vayu-cli not found. Please build the engine first:"
    echo "  ./scripts/build/build-macos.sh -e      # Production build"
    echo "  ./scripts/build/build-linux.sh -e      # Production build"
    echo "  ./scripts/build/build-macos.sh dev -e  # Development build"
    echo "  ./scripts/build/build-linux.sh dev -e  # Development build"
    exit 1
fi

echo "Using CLI: $CLI_PATH"
echo "Starting load test from $TEST_FILE..."
# Run the CLI and capture output
# We use a temporary file to capture output while also showing it if needed, 
# but here we just capture it to variable to parse Run ID.
OUTPUT=$(./$CLI_PATH run "$TEST_FILE_ABS")
echo "$OUTPUT"

# Extract Run ID
# Output format: "Run ID: run_1767359116299"
RUN_ID=$(echo "$OUTPUT" | grep "Run ID:" | awk '{print $3}')

if [ -z "$RUN_ID" ]; then
    echo "Error: Could not extract Run ID. Is the daemon running?"
    exit 1
fi

DAEMON_URL="http://127.0.0.1:9876"
LIVE_METRICS_URL="$DAEMON_URL/metrics/live/$RUN_ID"
STATS_URL="$DAEMON_URL/stats/$RUN_ID"

echo ""
echo "Streaming live metrics from $LIVE_METRICS_URL..."
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

# Function to stream from an SSE endpoint
# Returns 0 if successfully streamed data, 1 otherwise
stream_sse() {
    local url="$1"
    local show_full_report_hint="$2"
    local got_data=false
    
    while IFS= read -r line; do
        # Check for 404 JSON response (not SSE)
        if [[ "$line" == "{"*"error"* ]] && [ "$got_data" = false ]; then
            return 1
        fi
        
        if [[ "$line" == "event: complete" ]]; then
            echo ""
            echo "Test Completed!"
            # Read the next data line before exiting
            read -r next_line
            if [[ "$next_line" == "data: "* ]]; then
                JSON_DATA="${next_line#data: }"
                echo "$JSON_DATA" | format_json
            fi
            echo "----------------------------------------"
            if [ "$show_full_report_hint" = "true" ]; then
                echo "Full report available at: $STATS_URL"
            fi
            return 0
        elif [[ "$line" == "event: error" ]]; then
            echo "Error occurred during streaming"
            continue
        elif [[ "$line" == "data: "* ]]; then
            got_data=true
            JSON_DATA="${line#data: }"
            echo "$JSON_DATA" | format_json
        fi
    done < <(curl -N -s "$url" 2>/dev/null)
    
    # If we got data but stream ended without complete event
    if [ "$got_data" = true ]; then
        echo "----------------------------------------"
        return 0
    fi
    
    return 1
}

# Try live metrics endpoint immediately (no delay - test might be fast)
if stream_sse "$LIVE_METRICS_URL" "true"; then
    exit 0
fi

# Fallback to stats endpoint for historical data
echo "Live metrics not available, using stats endpoint..."
if stream_sse "$STATS_URL" "false"; then
    exit 0
fi

echo "----------------------------------------"
echo "No data received. Is the daemon running?"
