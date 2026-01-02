# Vayu Scripting Guide

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

Vayu includes a QuickJS-based JavaScript engine that provides Postman-compatible scripting for:

- **Pre-request scripts:** Modify requests before sending (set headers, compute auth, etc.)
- **Test scripts:** Validate responses with assertions (`pm.test()`, `pm.expect()`)
- **Environment variables:** Manage dynamic configuration

---

## Quick Start

### Simple Test Script

```javascript
// test.json in POST /request body
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "postRequestScript": "pm.test('Status is 200', function() { pm.expect(pm.response.code).to.equal(200); })"
}
```

### Pre-request Script

```javascript
// Compute authorization header before sending
"preRequestScript": "pm.request.headers['Authorization'] = 'Bearer ' + pm.environment.get('token')"
```

---

## The `pm` Object

### Response Object (`pm.response`)

Access the HTTP response:

```javascript
pm.response.code              // HTTP status code (number)
pm.response.status            // Alias for code
pm.response.headers           // Response headers (object, lowercase keys)
pm.response.body              // Raw response body (string)
pm.response.text()            // Response body as string
pm.response.json()            // Parse JSON response (throws if invalid)
pm.response.time              // Response time in milliseconds (number)
```

**Example:**
```javascript
// Log response status
console.log("Status: " + pm.response.code);

// Parse JSON response
var json = pm.response.json();
console.log("User: " + json.name);

// Check header
var contentType = pm.response.headers["content-type"];
```

### Request Object (`pm.request`)

Access the HTTP request being sent:

```javascript
pm.request.method             // HTTP method (GET, POST, etc.)
pm.request.url                // Full request URL
pm.request.headers            // Request headers (object)
pm.request.body               // Request body (string)
```

**Example:**
```javascript
console.log("Sending: " + pm.request.method + " " + pm.request.url);
```

### Environment Variables (`pm.environment`)

Read and write variables:

```javascript
pm.environment.get("key")         // Read variable (string or null)
pm.environment.set("key", "value") // Set variable
```

**Variables are:**
- Scoped to the execution
- Persisted in database
- Usable in URLs via `{{variable}}`

**Example:**
```javascript
// Set variable from response
var token = pm.response.json().auth_token;
pm.environment.set("auth_token", token);

// Use in next request URL
// URL: https://api.example.com/me?token={{auth_token}}
```

---

## Testing API (`pm.test()` and `pm.expect()`)

### Defining Tests

```javascript
pm.test("description", function() {
    // Test code
});
```

Tests can:
- Pass (no exceptions)
- Fail (throw exception)
- Make assertions with `pm.expect()`

**Example:**
```javascript
pm.test("Status is 200", function() {
    pm.expect(pm.response.code).to.equal(200);
});

pm.test("Body has id", function() {
    var json = pm.response.json();
    pm.expect(json).to.have.property("id");
});

pm.test("User name is John", function() {
    var json = pm.response.json();
    pm.expect(json.name).to.equal("John Doe");
});
```

### Assertion API (`pm.expect()`)

Create chainable assertions:

```javascript
pm.expect(actual)
```

#### Equality Assertions

```javascript
pm.expect(42).to.equal(42)          // Strict equality (===)
pm.expect("hello").to.equal("hello")

pm.expect(42).to.not.equal(43)      // Inequality (!==)
pm.expect("a").to.not.equal("b")
```

**Example:**
```javascript
pm.test("Response status", function() {
    pm.expect(pm.response.code).to.equal(200);
});
```

#### Comparison Assertions

```javascript
pm.expect(100).to.be.above(50)      // Greater than (>)
pm.expect(50).to.be.above(100)      // Fails

pm.expect(50).to.be.below(100)      // Less than (<)
pm.expect(150).to.be.below(100)     // Fails
```

**Example:**
```javascript
pm.test("Response time < 500ms", function() {
    pm.expect(pm.response.time).to.be.below(500);
});
```

#### Existence Assertions

```javascript
pm.expect(value).to.exist           // Truthy check
pm.expect(null).to.not.exist        // Falsy check
pm.expect(undefined).to.not.exist
```

**Example:**
```javascript
pm.test("Auth token exists", function() {
    var token = pm.response.json().token;
    pm.expect(token).to.exist;
});
```

#### Boolean Assertions

```javascript
pm.expect(true).to.be.true
pm.expect(false).to.be.false
pm.expect(1 === 1).to.be.true       // Any truthy value
```

**Example:**
```javascript
pm.test("Is valid", function() {
    var json = pm.response.json();
    pm.expect(json.valid).to.be.true;
});
```

#### String Containment

```javascript
pm.expect("hello world").to.include("world")
pm.expect("hello world").to.include("hello")
pm.expect([1, 2, 3]).to.include(2)                  // Array containment
```

**Example:**
```javascript
pm.test("Response contains user id", function() {
    var body = pm.response.body;
    pm.expect(body).to.include("user_id");
});
```

#### Property Assertions

```javascript
pm.expect(obj).to.have.property("key")
pm.expect(obj).to.have.property("key", expectedValue)
```

**Example:**
```javascript
pm.test("Response has user fields", function() {
    var json = pm.response.json();
    pm.expect(json).to.have.property("id");
    pm.expect(json).to.have.property("name");
    pm.expect(json).to.have.property("email");
});
```

#### Chaining with `.not`

All assertions can be negated:

```javascript
pm.expect(42).to.not.equal(43)
pm.expect(100).to.not.be.above(200)
pm.expect(null).to.not.exist
pm.expect(obj).to.not.have.property("missing_key")
```

#### Assertion Operators

| Operator | Aliases | Meaning |
|----------|---------|---------|
| `.to` | `.be` | Assertion marker (just for readability) |
| `.equal()` | `===` | Strict equality |
| `.above()` | `>` | Greater than |
| `.below()` | `<` | Less than |
| `.include()` | `.contain` | Contains substring/value |
| `.property()` | - | Object has property |
| `.exist` | - | Truthy value |
| `.true` | - | Strict `true` |
| `.false` | - | Strict `false` |
| `.not` | - | Negate assertion |

---

## Console Output

Use `console` object for debugging:

```javascript
console.log(value)      // Print to console
console.info(value)     // Alias
console.warn(value)     // Alias
console.error(value)    // Alias
```

Output is captured and returned in the response:

**Request:**
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "postRequestScript": "console.log('User ID:', pm.response.json().id)"
}
```

**Response:**
```json
{
  "consoleOutput": [
    "User ID: 42"
  ],
  "testResults": [...]
}
```

---

## Common Patterns

### 1. Extract and Store Token from Response

```javascript
pm.test("Extract auth token", function() {
    var json = pm.response.json();
    pm.expect(json).to.have.property("token");
    
    // Store token for next request
    pm.environment.set("auth_token", json.token);
});
```

### 2. Validate JSON Structure

```javascript
pm.test("Response has correct structure", function() {
    var json = pm.response.json();
    
    pm.expect(json).to.have.property("id");
    pm.expect(json).to.have.property("name");
    pm.expect(json).to.have.property("email");
    pm.expect(json).to.have.property("created_at");
});
```

### 3. Check Multiple Assertions

```javascript
pm.test("Full user response", function() {
    var json = pm.response.json();
    
    // Status
    pm.expect(pm.response.code).to.equal(200);
    
    // Fields exist
    pm.expect(json).to.have.property("id");
    pm.expect(json).to.have.property("username");
    
    // Field values
    pm.expect(json.id).to.be.above(0);
    pm.expect(json.username).to.include("user");
});
```

### 4. Set Headers from Environment

```javascript
// Pre-request script
var token = pm.environment.get("auth_token");
if (token) {
    pm.request.headers["Authorization"] = "Bearer " + token;
}
```

### 5. Conditional Assertions

```javascript
pm.test("Check optional field if present", function() {
    var json = pm.response.json();
    
    if (json.premium) {
        pm.expect(json.premium).to.be.true;
    }
});
```

### 6. Validate Response Time

```javascript
pm.test("Response is fast", function() {
    pm.expect(pm.response.time).to.be.below(100);
});

pm.test("Response is not too slow", function() {
    pm.expect(pm.response.time).to.be.below(5000);
});
```

### 7. Check Content Type

```javascript
pm.test("Response is JSON", function() {
    var contentType = pm.response.headers["content-type"];
    pm.expect(contentType).to.include("application/json");
});
```

---

## Configuration

### Script Limits

Control script behavior via `ScriptConfig`:

```cpp
struct ScriptConfig {
    size_t memory_limit = 64 * 1024 * 1024;  // 64 MB
    uint64_t timeout_ms = 5000;              // 5 seconds
    size_t stack_size = 256 * 1024;          // 256 KB
    bool enable_console = true;              // Enable console.log()
};
```

**Behavior:**
- If script uses >64MB memory: Execution aborted
- If script runs >5 seconds: Execution aborted
- If console disabled: console.* calls are no-ops

---

## Error Handling

### Script Execution Errors

If a script throws an exception, the result includes error details:

```json
{
  "success": false,
  "error_message": "ReferenceError: undefined_variable is not defined at line 5:10",
  "tests": [
    {
      "name": "First test",
      "passed": true
    },
    {
      "name": "Second test",
      "passed": false,
      "error_message": "TypeError: Cannot read property 'id' of undefined"
    }
  ]
}
```

### Common Errors

**Parsing JSON on non-JSON response:**
```javascript
// ❌ Wrong - throws if body is not JSON
var json = pm.response.json();

// ✅ Better - check content type first
if (pm.response.headers["content-type"].includes("application/json")) {
    var json = pm.response.json();
}
```

**Accessing undefined variables:**
```javascript
// ❌ Wrong - throws if token not set
var token = pm.environment.get("token");
pm.request.headers["Authorization"] = "Bearer " + token;

// ✅ Better - check if exists
var token = pm.environment.get("token");
if (token) {
    pm.request.headers["Authorization"] = "Bearer " + token;
}
```

---

## Testing Your Scripts

### Via HTTP API

```bash
curl -X POST http://127.0.0.1:9876/request \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "url": "https://api.example.com/users",
    "postRequestScript": "pm.test(\"OK\", () => pm.expect(pm.response.code).to.equal(200))"
  }'
```

### Via CLI

```bash
./vayu-cli run request.json
```

where `request.json` contains:
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "postRequestScript": "pm.test('OK', function() { pm.expect(pm.response.code).to.equal(200); })"
}
```

---

## Performance Tips

1. **Keep scripts short** - Minimize memory usage
2. **Cache computed values** - Avoid repeated calculations
3. **Use simple types** - Avoid complex object operations
4. **Check before access** - Validate existence before using properties

---

## Limitations

- **No file system access** - Cannot read/write files
- **No external network** - Cannot make HTTP requests (use `pm.request`/`pm.response` instead)
- **No setTimeout** - No async/delayed execution
- **No require/import** - Single-file scripts only

---

*See: [Architecture - Script Engine](architecture.md#quickjs-script-engine) | [API Reference](api-reference.md)*
