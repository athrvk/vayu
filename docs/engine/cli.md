# Vayu CLI Reference

**Version:** 1.1  
**Last Updated:** January 10, 2026

---

## Overview

The Vayu CLI (`vayu-cli`) is a lightweight remote control for the Vayu Engine. It connects to the running daemon (`vayu-engine`) to execute requests and manage load tests.

**Prerequisite:** The Vayu Engine must be running (`./vayu-engine`).

---

## Commands

### `run` - Execute Single Request (Design Mode)

Execute a single HTTP request via the daemon and display the response.

```bash
vayu-cli run <request.json> [OPTIONS]
```

**Arguments:**
- `<request.json>` - Path to JSON request file (required)

**Options:**
- `-p, --port <port>` - Daemon port (default: 9876)
- `-v, --verbose` - Show detailed output
- `-h, --help` - Show help message

### `load` - Start Load Test (Load Mode)

Initiate a load test on the daemon.

```bash
vayu-cli load <config.json> [OPTIONS]
```

**Arguments:**
- `<config.json>` - Path to load test configuration file

### `status` - Check Daemon Status

Check if the daemon is running and healthy.

```bash
vayu-cli status
```

---

## Examples

**1. Run a single request:**
```bash
# Start the daemon first
./vayu-engine &

# Run request
vayu-cli run requests/login.json
```

**2. Start a load test:**
```bash
vayu-cli load tests/stress-test.json
```

**3. Check status:**
```bash
vayu-cli status -p 9876
```

```bash
# Basic request
vayu-cli run request.json

# With verbose output
vayu-cli run request.json --verbose

# Disable colors
vayu-cli run request.json --no-color
```

**Output Example:**

```
Request:
  Method: GET
  URL: https://httpbin.org/json
  Timeout: 10000 ms

200 OK
Time: 234.5 ms
Size: 1024 bytes

Headers:
  Content-Type: application/json
  Server: gunicorn/19.9.0

Body:
{
  "slideshow": {
    "author": "Yours Truly",
    "title": "Sample Slide Show"
  }
}

Tests:
  ✓ Status code is 200
  ✓ Response is JSON
  ✓ Slideshow has title
```

**Request File Format:**

```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {
    "Authorization": "Bearer token",
    "Content-Type": "application/json"
  },
  "body": {
    "mode": "json",
    "content": {
      "name": "John Doe"
    }
  },
  "timeout": 30000,
  "followRedirects": true,
  "maxRedirects": 5,
  "tests": "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

**Request Properties:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `method` | string | ✅ | HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS |
| `url` | string | ✅ | Request URL |
| `headers` | object | ❌ | Custom headers (key-value) |
| `body` | object | ❌ | Request body configuration |
| `body.mode` | string | ❌ | Body format: `json`, `text`, `form`, `formdata`, `binary`, `none` |
| `body.content` | any | ❌ | Body content (type depends on `body.mode`) |
| `timeout` | number | ❌ | Request timeout in milliseconds (default: 30000) |
| `followRedirects` | boolean | ❌ | Follow HTTP 3xx redirects (default: true) |
| `maxRedirects` | number | ❌ | Maximum redirects to follow (default: 10) |
| `tests` | string | ❌ | Postman-compatible test script (JavaScript) |

---

### `batch` - Execute Multiple Requests

Execute multiple requests concurrently and collect performance metrics.

```bash
vayu-cli batch <file1.json> [file2.json] ... [OPTIONS]
```

**Arguments:**
- `<file1.json>` [file2.json] ... - One or more JSON request files (required)

**Options:**
- `--concurrency <n>` - Maximum concurrent requests (default: 10)
- `-v, --verbose` - Show per-request details
- `--no-color` - Disable colored output
- `-h, --help` - Show help message

**Example:**

```bash
# Run 3 requests with default concurrency (10)
vayu-cli batch req1.json req2.json req3.json

# Run with concurrency of 50
vayu-cli batch *.json --concurrency 50

# Verbose output with timing
vayu-cli batch req1.json req2.json --verbose
```

**Output Example:**

```
Running 3 requests with concurrency 10...

✓ req1.json - 200 (45.2 ms)
✓ req2.json - 201 (78.5 ms)
✓ req3.json - 500
────────────────────────────────────────
Total: 3 requests in 124.7 ms
2 successful, 1 failed
Average: 41.57 ms/request
```

**Concurrency & Performance:**

- **Default concurrency:** 10 (can be adjusted with `--concurrency`)
- **Execution model:** Lock-free SPSC queues with curl_multi event loop
- **Per-worker:** Each worker thread has its own lock-free connection pool
- **Max throughput:** 60,000+ RPS (system dependent, see architecture docs)

**Performance Testing:**

To test high-throughput scenarios, adjust concurrency:

```bash
# Test 100 concurrent requests (10 RPS on 10s test with 100 reqs)
for i in {1..100}; do
  vayu-cli run httpbin-test.json &
done
wait

# Or use batch for coordinated execution
vayu-cli batch httpbin-test.json httpbin-test.json httpbin-test.json \
  --concurrency 100
```

---

## Global Options

These options work with all commands:

```bash
vayu-cli [OPTIONS] COMMAND [COMMAND_OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-v, --version` | Print CLI version and exit |
| `-h, --help` | Print help message and exit |

**Examples:**

```bash
vayu-cli --version
vayu-cli --help
```

---

## Request File Examples

### Example 1: Simple GET Request

File: `simple-get.json`

```json
{
  "method": "GET",
  "url": "https://httpbin.org/get"
}
```

Run it:

```bash
vayu-cli run simple-get.json
```

### Example 2: POST with JSON Body and Tests

File: `create-user.json`

```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer {{token}}"
  },
  "body": {
    "mode": "json",
    "content": {
      "name": "Alice Johnson",
      "email": "alice@example.com"
    }
  },
  "timeout": 10000,
  "tests": "pm.test('User created', () => {\n  pm.expect(pm.response.code).to.equal(201);\n  var body = pm.response.json();\n  pm.expect(body).to.have.property('id');\n});"
}
```

Run with verbose output:

```bash
vayu-cli run create-user.json --verbose
```

### Example 3: Multiple Requests for Batch Execution

File: `requests/health-check.json`

```json
{
  "method": "GET",
  "url": "https://api.example.com/health",
  "timeout": 5000,
  "tests": "pm.test('Service healthy', () => pm.expect(pm.response.code).to.equal(200));"
}
```

File: `requests/list-users.json`

```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {
    "Authorization": "Bearer token"
  },
  "timeout": 10000,
  "tests": "pm.test('Get users', () => pm.expect(pm.response.code).to.equal(200));"
}
```

Run them together:

```bash
vayu-cli batch requests/*.json --concurrency 20 --verbose
```

---

## Test Scripts (Postman-Compatible)

The `tests` field in request files accepts JavaScript code that runs after the response is received. It has access to Postman-compatible objects.

### Available Objects

**`pm.test(name, fn)`** - Define a test case

```javascript
pm.test('Status is 200', () => {
  pm.expect(pm.response.code).to.equal(200);
});
```

**`pm.expect(value)`** - Create an assertion

Supported assertions:
- `.to.equal(expected)` - Equality check
- `.to.not.equal(expected)` - Inequality check
- `.to.be.above(expected)` - Greater than
- `.to.be.below(expected)` - Less than
- `.to.include(substring)` - String contains
- `.to.have.property(name)` - Object has property
- `.to.be.true` / `.to.be.false` - Boolean check
- `.to.exist` / `.to.not.exist` - Existence check

**`pm.response`** - Response object

```javascript
pm.response.code              // Status code (number)
pm.response.status            // Status text (string)
pm.response.json()            // Parse body as JSON (object)
pm.response.text()            // Body as text (string)
pm.response.headers           // Response headers (object)
pm.response.responseTime      // Time in ms (number)
```

**`pm.request`** - Request object

```javascript
pm.request.url                // Request URL
pm.request.method             // HTTP method
pm.request.headers            // Request headers
```

**`console.log(message)`** - Debug output

```javascript
console.log('Response body:', pm.response.json());
```

### Example Test Script

```javascript
pm.test('Status is 2xx', () => {
  pm.expect(pm.response.code).to.be.above(199);
  pm.expect(pm.response.code).to.be.below(300);
});

pm.test('Response has expected structure', () => {
  var body = pm.response.json();
  pm.expect(body).to.have.property('id');
  pm.expect(body).to.have.property('name');
});

pm.test('No errors in response', () => {
  var body = pm.response.json();
  pm.expect(body.error).to.not.exist;
});

console.log('✓ All checks passed');
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (all requests succeeded, all tests passed) |
| `1` | Failure (one or more requests failed or tests failed) |

Use these in scripts:

```bash
vayu-cli run request.json
if [ $? -eq 0 ]; then
  echo "✓ Request successful"
else
  echo "✗ Request failed"
  exit 1
fi
```

---

## CLI vs HTTP API

| Feature | CLI | HTTP API |
|---------|-----|----------|
| Single request | ✅ `run` | ✅ `POST /request` |
| Batch requests | ✅ `batch` | ✅ `POST /run` |
| Test scripts | ✅ Yes | ✅ Yes |
| Load strategies | ❌ | ✅ (3 modes) |
| Real-time stats | ❌ | ✅ SSE streaming |
| RPS rate limiting | ❌ | ✅ Precise timing |
| Progress tracking | ❌ | ✅ sent/expected |
| Latency percentiles | ❌ Summary | ✅ Full percentiles |
| Access method | Command line | HTTP requests |

**Current Status:**
- **CLI:** Fully implemented with `run` (single) and `batch` (concurrent) commands
- **HTTP API:** Fully implemented load testing with async execution, real-time metrics streaming, and multiple load strategies

**Recommendations:**
- **Simple testing:** Use CLI `run` for quick single requests
- **Concurrent execution:** Use CLI `batch` for straightforward parallel testing
- **Advanced load testing:** Use HTTP API `POST /run` for:
  - Precise RPS rate limiting (e.g., exactly 50 RPS)
  - Real-time metrics streaming via SSE
  - Multiple load strategies (constant, iterations, ramp-up)
  - Progress tracking (requests sent vs expected)
  - Detailed percentile analysis
  - Asynchronous execution with long-running tests

---

## Troubleshooting

### "Unknown command" error

```bash
$ vayu-cli request file.json
Error: Unknown command 'request'
```

**Solution:** Use `run` instead of `request`

```bash
vayu-cli run file.json
```

### "Failed to open file" error

```bash
Error: Failed to open file: nonexistent.json
```

**Solution:** Check file path and permissions

```bash
ls -l path/to/file.json
vayu-cli run ./path/to/file.json
```

### Tests not running

If tests are defined but not executing:

1. Ensure the `tests` field is present in the JSON
2. Verify QuickJS scripting is enabled (built with `VAYU_HAS_QUICKJS`)
3. Check syntax of test JavaScript code

### High concurrency issues

If batch with very high concurrency fails:

1. Reduce concurrency: `--concurrency 50` (start with 50, increase gradually)
2. Check system file descriptor limits: `ulimit -n`
3. Increase timeout: `timeout` field in request JSON
4. Reduce request timeout values to avoid blocking

---

## Tips & Best Practices

1. **Store fixture files** - Keep request JSONs in a `requests/` or `fixtures/` directory for reusability
2. **Use glob patterns** - `vayu-cli batch requests/*.json` to run all requests in a directory
3. **Add descriptive names** - Use file names that describe what each request does
4. **Include timeouts** - Always set reasonable timeout values in request files
5. **Test first** - Use `run` to validate a single request before adding to batch
6. **Version control** - Commit request files to git for team collaboration
7. **Batch for CI/CD** - Use `batch` in automated test pipelines
8. **Monitor exit codes** - Check `$?` to detect failures in scripts

---

## Related Documentation

- [API Reference](api-reference.md) - HTTP API endpoints (daemon)
- [Architecture](architecture.md) - Internal design and components
- [Building](building.md) - Build instructions and environment setup

