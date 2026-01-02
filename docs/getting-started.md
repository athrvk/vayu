# Getting Started with Vayu

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Installation

### macOS

#### Download (Recommended)

1. Go to [GitHub Releases](https://github.com/vayu/vayu/releases)
2. Download `Vayu-x.x.x-universal.dmg`
3. Open the DMG and drag Vayu to Applications
4. Launch Vayu from Applications

#### Homebrew

```bash
brew install --cask vayu
```

### Windows

Coming soon.

### Linux

Coming soon.

---

## Quick Start

### Your First Request

1. **Launch Vayu** - The app opens with a blank request tab
2. **Enter URL** - Type `https://httpbin.org/get` in the URL bar
3. **Send** - Click the **Send** button (or press `Cmd+Enter`)
4. **View Response** - See the JSON response in the Response panel

```
┌─────────────────────────────────────────────────────────────────┐
│  Vayu                                                      ─ □ x │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ GET  ▼ │ https://httpbin.org/get                   │ Send │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Params  │  Headers  │  Body  │  Auth  │  Scripts               │
│  ─────────────────────────────────────────────────────────────  │
│  (No parameters)                                                │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Response                                        200 OK  234ms  │
│  ─────────────────────────────────────────────────────────────  │
│  Body  │  Headers  │  Cookies  │  Tests                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ {                                                         │  │
│  │   "args": {},                                             │  │
│  │   "headers": {                                            │  │
│  │     "Host": "httpbin.org",                                │  │
│  │     "User-Agent": "Vayu/0.1.0"                            │  │
│  │   },                                                      │  │
│  │   "url": "https://httpbin.org/get"                        │  │
│  │ }                                                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Making a POST Request

1. Change method to **POST**
2. Enter URL: `https://httpbin.org/post`
3. Go to **Body** tab
4. Select **JSON** mode
5. Enter body:
   ```json
   {
     "name": "John Doe",
     "email": "john@example.com"
   }
   ```
6. Click **Send**

### Adding Headers

1. Go to **Headers** tab
2. Add a new header:
   - Key: `Authorization`
   - Value: `Bearer my-token-123`
3. Headers are automatically sent with the request

---

## Working with Variables

### Environment Variables

Variables let you reuse values across requests.

1. **Create Environment**
   - Click the environment dropdown (top-right)
   - Select **Manage Environments**
   - Click **+ New Environment**
   - Name it "Development"

2. **Add Variables**
   ```
   baseUrl    = https://api.dev.example.com
   authToken  = dev-token-123
   ```

3. **Use Variables**
   - In URL: `{{baseUrl}}/users`
   - In Headers: `Bearer {{authToken}}`

### Variable Syntax

```
{{variableName}}
```

Variables can be used in:
- URL
- Headers (keys and values)
- Body
- Query parameters
- Authentication fields

### Variable Scope

| Scope | Persistence | Override Priority |
|-------|-------------|-------------------|
| Global | Across sessions | Lowest |
| Environment | Per environment | Medium |
| Collection | Per collection | High |
| Request | Single request | Highest |

---

## Writing Tests

Add assertions to validate responses.

### Basic Test

Go to **Scripts** tab → **Post-response**:

```javascript
pm.test("Status is 200", function() {
    pm.expect(pm.response.code).to.equal(200);
});

pm.test("Response has data", function() {
    var json = pm.response.json();
    pm.expect(json).to.have.property("data");
});
```

### Common Assertions

```javascript
// Status code
pm.expect(pm.response.code).to.equal(200);
pm.expect(pm.response.code).to.be.within(200, 299);

// Response time
pm.expect(pm.response.responseTime).to.be.below(500);

// Headers
pm.expect(pm.response.headers["content-type"]).to.include("application/json");

// Body content
var json = pm.response.json();
pm.expect(json.success).to.be.true;
pm.expect(json.items).to.have.length(10);
pm.expect(json.name).to.match(/^[A-Z]/);
```

### Viewing Test Results

After sending, check the **Tests** tab in the response panel:

```
✓ Status is 200                    PASS
✓ Response has data                PASS
✗ Response time < 100ms            FAIL
  AssertionError: expected 234 to be below 100
```

---

## Load Testing (Vayu Mode)

Vayu's killer feature: run the same request at massive scale with precise control.

### Starting a Load Test

1. Configure your request normally
2. Click **Vayu** button (lightning bolt icon)
3. Configure load test:
   ```
   Mode:        Constant (Rate-Limited)
   Duration:    60 seconds
   Target RPS:  50
   ```
4. Click **Start Test**

### Load Test Modes

| Mode | Description | Configuration | Use Case |
|------|-------------|---------------|----------|
| **Constant (Rate-Limited)** | Precise RPS control | `targetRps`, `duration` | API rate limit testing, sustained load |
| **Constant (Concurrency)** | Max concurrent connections | `concurrency`, `duration` | Throughput testing, connection stress |
| **Iterations** | Fixed request count | `iterations`, `concurrency` | Functional testing, data operations |
| **Ramp-Up** | Gradual load increase | `stages` with RPS/duration | Soak testing, capacity planning |

### Configuration Examples

**Rate-Limited Test (50 RPS for 2 minutes):**
```json
{
  "mode": "constant",
  "duration": 120,
  "targetRps": 50
}
```

**Iterations Test (1000 requests, 10 at a time):**
```json
{
  "mode": "iterations",
  "iterations": 1000,
  "concurrency": 10
}
```

**Ramp-Up Test (gradually increase from 10 to 100 RPS):**
```json
{
  "mode": "ramp_up",
  "stages": [
    { "duration": 10, "targetRps": 10 },
    { "duration": 20, "targetRps": 50 },
    { "duration": 30, "targetRps": 100 }
  ]
}
```

### Real-Time Metrics

Watch live metrics stream as your test runs:
- **RPS** - Current requests per second
- **Latency** - Average, P50, P95, P99 percentiles
- **Error Rate** - Percentage of failed requests
- **Progress** - Requests sent vs expected (e.g., 52/100)
- **Active Connections** - Currently in-flight requests

### Reading Results

```
┌─────────────────────────────────────────────────────────────────┐
│  Load Test Results - run_1767386768697                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Duration:        60.0s          Total Requests:     3,000      │
│  Avg RPS:         50.0           Success Rate:       100.0%     │
│  Progress:        3000/3000      Status:              Completed │
│                                                                 │
│  Latency (ms)                                                   │
│  ─────────────────────────────────────────────────────────────  │
│  avg      p50      p95      p99      max                        │
│  10.2     8.5      25.7     45.2     234.5                      │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │    ████                                                   │  │
│  │   █████████                                               │  │
│  │  █████████████                                            │  │
│  │ ███████████████████                    ▲ p99              │  │
│  │███████████████████████████████                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│    0ms              50ms              100ms                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Metrics:**
- **Duration:** Actual test runtime (should match configured duration)
- **Total Requests:** Number of completed requests
- **Avg RPS:** Measured requests per second (should match targetRps)
- **Success Rate:** Percentage of 2xx responses
- **Progress:** Shows requests_sent/requests_expected for tracking

---

## Collections

Organize requests into collections for better management.

### Creating a Collection

1. Click **+** in the sidebar
2. Select **New Collection**
3. Name it (e.g., "My API")
4. Drag requests into the collection

### Collection Structure

```
📁 My API
├── 📁 Authentication
│   ├── 📄 Login
│   ├── 📄 Refresh Token
│   └── 📄 Logout
├── 📁 Users
│   ├── 📄 List Users
│   ├── 📄 Get User
│   ├── 📄 Create User
│   └── 📄 Delete User
└── 📄 Health Check
```

### Running a Collection

1. Right-click the collection
2. Select **Run Collection**
3. Configure run options:
   - Iterations: `1`
   - Delay between requests: `0ms`
   - Environment: `Development`
4. Click **Run**

---

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Send Request | `Cmd+Enter` | `Ctrl+Enter` |
| New Request | `Cmd+N` | `Ctrl+N` |
| New Tab | `Cmd+T` | `Ctrl+T` |
| Close Tab | `Cmd+W` | `Ctrl+W` |
| Save | `Cmd+S` | `Ctrl+S` |
| Import | `Cmd+I` | `Ctrl+I` |
| Find | `Cmd+F` | `Ctrl+F` |
| Toggle Sidebar | `Cmd+B` | `Ctrl+B` |
| Open Settings | `Cmd+,` | `Ctrl+,` |
| Switch Environment | `Cmd+E` | `Ctrl+E` |

---

## CLI Usage

The Vayu CLI (`vayu-cli`) provides command-line access to the engine for automation and CI/CD pipelines.

**Prerequisite:** The Vayu Engine daemon must be running (`./vayu-engine`).

### Starting the Engine

```bash
# Start the daemon (runs on port 9876)
./vayu-engine &

# Check if it's running
vayu-cli status
```

### Basic Commands

#### Run Single Request

```bash
# Execute a single request
vayu-cli run request.json

# With verbose output
vayu-cli run request.json --verbose

# Specify daemon port
vayu-cli run request.json --port 9876
```

**Request File Example:**
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {
    "Authorization": "Bearer token123"
  },
  "timeout": 30000,
  "tests": "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

#### Start Load Test

```bash
# Run a load test
vayu-cli load load-test-config.json
```

**Load Test Config Example:**
```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/health"
  },
  "mode": "constant",
  "duration": 60,
  "targetRps": 50
}
```

#### Check Daemon Status

```bash
# Verify daemon is running
vayu-cli status

# Output:
# Engine Status: Running
# Version: 0.1.0
# Port: 9876
# Uptime: 120 seconds
```

### Use Cases

**CI/CD Integration:**
```bash
#!/bin/bash
# Start engine
./vayu-engine &
ENGINE_PID=$!

# Wait for startup
sleep 2

# Run API tests
vayu-cli run tests/api-health.json
vayu-cli run tests/api-login.json
vayu-cli run tests/api-users.json

# Cleanup
kill $ENGINE_PID
```

**Quick API Testing:**
```bash
# Test multiple endpoints quickly
vayu-cli run health.json
vayu-cli run login.json
vayu-cli run data.json
```

**Load Testing:**
```bash
# Start engine
./vayu-engine &

# Run 50 RPS load test for 2 minutes
vayu-cli load load-test.json

# Monitor with real-time metrics via API:
# GET http://localhost:9876/stats/{runId} (SSE)
```

### Output Format

**Success:**
```
Request:
  Method: GET
  URL: https://httpbin.org/json
  Timeout: 10000 ms

200 OK
Time: 234.5 ms
Size: 1024 bytes

Tests:
  ✓ Status code is 200
  ✓ Response is JSON
```

**Failure:**
```
Request:
  Method: GET
  URL: https://api.example.com/broken

✗ 500 Internal Server Error
Time: 156.3 ms

Tests:
  ✗ Status code is 200
    AssertionError: expected 500 to equal 200
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (all tests passed) |
| `1` | Failure (request failed or tests failed) |

Use in scripts:
```bash
if vayu-cli run test.json; then
  echo "✓ Tests passed"
else
  echo "✗ Tests failed"
  exit 1
fi
```

---

## Advanced Features

For more CLI options and advanced usage, see:
- [CLI Reference](engine/cli.md) - Complete command documentation
- [API Reference](engine/api-reference.md) - HTTP API for load testing

---

## Configuration

### Settings Location

- macOS: `~/Library/Application Support/Vayu/settings.json`
- Windows: `%APPDATA%\Vayu\settings.json`
- Linux: `~/.config/Vayu/settings.json`

### Common Settings

```json
{
  "general": {
    "theme": "dark",
    "fontSize": 14,
    "autoSave": true
  },
  "requests": {
    "timeout": 30000,
    "followRedirects": true,
    "validateSSL": true
  },
  "engine": {
    "workers": 8,
    "maxConnections": 10000
  },
  "proxy": {
    "enabled": false,
    "url": "http://localhost:8080"
  }
}
```

---

## Next Steps

- **[API Reference](api-reference.md)** - Engine API documentation
- **[Architecture](architecture.md)** - How Vayu works internally
- **[Postman Migration](postman-migration.md)** - Coming from Postman?

---

*← [Postman Migration](postman-migration.md)*
