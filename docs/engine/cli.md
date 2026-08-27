---
description: >-
  The vayu-cli command line: flags and subcommands for running requests and load tests against the engine without the desktop app.
---

# Vayu CLI Reference

The `vayu-cli` tool executes HTTP requests and load tests via the Vayu Engine daemon.

## Usage

```bash
vayu-cli <COMMAND> [OPTIONS]
```

## Commands

### run

Execute a request or load test from a JSON file.

```bash
vayu-cli run <file.json>
```

The CLI automatically detects whether the JSON file contains a single request or a load test configuration based on the presence of `mode`, `duration`, or `iterations` fields.

**Examples:**

```bash
# Execute a single request
vayu-cli run request.json

# Execute a load test
vayu-cli run load-test.json

# Use custom daemon URL
vayu-cli run request.json --daemon http://localhost:9999
```

## Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help message |
| `-v, --version` | Show version information |
| `--verbose [LEVEL]` | Enable verbose output. LEVEL is 0 (warn/error), 1 (info) or 2 (debug); `--verbose` on its own means 1. A level outside 0-2, or one that is not a whole number, is refused with exit code 1 |
| `--no-color` | Disable colored output |
| `--daemon <url>` | Vayu Engine URL (default: http://127.0.0.1:9876) |

## Request File Format

### Single Request

```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {
    "Authorization": "Bearer {{token}}"
  },
  "body": {
    "type": "json",
    "content": "{\"name\":\"John\"}"
  },
  "environmentId": "env_1234567890",
  "preRequestScript": "",
  "postRequestScript": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

### Load Test

```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/users",
    "headers": {},
    "body": {
      "type": "none",
      "content": ""
    }
  },
  "mode": "constant_rps",
  "targetRps": 1000,
  "duration": "60s",
  "environmentId": "env_1234567890",
  "testScript": ""
}
```

**Load Test Modes:**

- **constant_rps**: Open-loop - dispatch at `targetRps` for `duration` (use `maxInFlight` to cap outstanding requests)
- **constant_concurrency**: Closed-loop - hold `concurrency` in-flight requests for `duration`
- **ramp_up**: Closed-loop - ramp concurrency `startConcurrency` → `concurrency` over `rampUpDuration`, then hold to `duration` (total)
- **iterations**: Closed-loop, bounded - issue `iterations` total requests at `concurrency`

## Output

### Single Request

The CLI prints:
- HTTP status code and status text
- Response time
- Response size
- Headers
- Body (formatted JSON if applicable)
- Test results (if test script provided)

**Example output:**

```
200 OK
Time: 245.5 ms
Size: 1024 bytes

Headers:
  content-type: application/json
  content-length: 1024

Body:
{
  "id": 1,
  "name": "John"
}
```

### Load Test

The CLI prints:
- Run ID
- Link to the live metrics stream

**Example output:**

```
Run ID: run_1234567890
Monitor status at: http://127.0.0.1:9876/runs/run_1234567890/live
```

Use that URL to stream real-time metrics via Server-Sent Events (SSE). It serves
from the engine's in-memory collector, and a **finished** run stays readable for
the `liveRetentionMs` window (default 60s, `GET /config`) - a reader attaching
late still gets the run's ticks replayed from the start. Once that window
expires, or for a run id the engine has never seen, it returns `404` with a hint
pointing at `GET /runs/:runId/report` for the stored report.

## Prerequisites

The Vayu Engine daemon must be running before using the CLI:

```bash
# Start daemon (in another terminal)
./engine/build/vayu-engine

# Then use CLI
vayu-cli run request.json
```

The daemon exits **1** if it cannot take its port, naming the address on
stderr - another process is listening there. Use `--port` to pick a different
one, and `--daemon` to point the CLI at it. An ordinary shutdown exits **0**.

Its numeric flags are checked before anything starts, and a value that is not
one of the numbers the flag takes is refused on stderr with exit code **1**
rather than clamped or read as its numeric prefix:

| Daemon flag | Accepts |
|-------------|---------|
| `-p, --port <PORT>` | A whole number from 1 to 65535 |
| `-v, --verbose [LEVEL]` | 0 (warn/error), 1 (info) or 2 (debug); `-v` on its own means 1 |

```
$ vayu-engine --port notanumber
vayu-engine: --port expects a number between 1 and 65535, got "notanumber"
```

## Error Handling

The CLI returns non-zero exit codes on errors:

- **1**: Command error (invalid file, connection failed, etc.)
- **0**: Success

Error messages are printed to stderr with details about what went wrong.

## Examples

### Basic Request

```bash
# Create request.json
cat > request.json << EOF
{
  "method": "GET",
  "url": "https://httpbin.org/get",
  "headers": {},
  "body": {"type": "none", "content": ""}
}
EOF

# Execute
vayu-cli run request.json
```

### Load Test with Verbose Output

```bash
vayu-cli run load-test.json --verbose 2
```

### Custom Daemon Port

```bash
vayu-cli run request.json --daemon http://localhost:9999
```

### Disable Colors (for scripts)

```bash
vayu-cli run request.json --no-color > output.txt
```

## Integration

The CLI is designed for:
- CI/CD pipelines
- Automated testing
- Scripting and automation
- Command-line workflows

For interactive use, prefer the Electron UI which provides a richer experience.
