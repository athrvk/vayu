# Vayu CLI Reference

## Commands

```bash
vayu-cli request <file.json>     # Execute request
vayu-cli load-test <file.json>   # Run load test
vayu-cli health                  # Check engine status
vayu-cli version                 # Show version
```

## Request JSON Format

```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": [
    { "key": "Content-Type", "value": "application/json" }
  ],
  "body": {
    "type": "json",
    "content": "{\"name\":\"John\"}"
  }
}
```

## Load Test JSON Format

```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/users",
    "headers": [],
    "body": { "type": "none", "content": "" }
  },
  "virtualUsers": 100,
  "duration": 60,
  "rampUp": 10,
  "iterations": 0
}
```

## Options

| Option | Description |
|--------|-------------|
| `--verbose` | Enable detailed output |
| `--output <file>` | Save results to file |
| `--format json` | Output as JSON |

## Examples

```bash
# Simple request
vayu-cli request get-users.json

# Load test with verbose output
vayu-cli load-test stress-test.json --verbose

# Save report
vayu-cli load-test stress-test.json --output report.json
```
