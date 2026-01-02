#!/bin/bash

echo "Testing all three load test strategies..."
echo

# Test 1: Constant Load
echo "=== Test 1: Constant Load (5s duration) ==="
RUN_ID=$(./engine/build/vayu-cli run scripts/load-test-example.json | grep "Run ID:" | awk '{print $3}')
echo "Run ID: $RUN_ID"
sleep 6
curl -s "http://127.0.0.1:9876/run/$RUN_ID/report" | jq '.summary'
echo

# Test 2: Iterations
echo "=== Test 2: Iterations (50 requests) ==="
RUN_ID=$(./engine/build/vayu-cli run scripts/iterations-test.json | grep "Run ID:" | awk '{print $3}')
echo "Run ID: $RUN_ID"
sleep 3
curl -s "http://127.0.0.1:9876/run/$RUN_ID/report" | jq '.summary'
echo

# Test 3: Ramp Up
echo "=== Test 3: Ramp Up (10s with 5s ramp) ==="
RUN_ID=$(./engine/build/vayu-cli run scripts/ramp-up-test.json | grep "Run ID:" | awk '{print $3}')
echo "Run ID: $RUN_ID"
sleep 12
curl -s "http://127.0.0.1:9876/run/$RUN_ID/report" | jq '.summary'
echo

echo "All tests completed!"
