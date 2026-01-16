# Vayu Scripting Guide

Vayu uses QuickJS for JavaScript execution in pre-request and test scripts. The scripting API is compatible with Postman's `pm` object, making it easy to migrate tests from Postman.

## Quick Start

```javascript
// Test script example
pm.test('Status is 200', function() {
  pm.expect(pm.response.code).to.equal(200);
});

pm.test('Response has user data', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
});
```

## The `pm` Object

### pm.test()

Define a test with assertions.

```javascript
pm.test('Test name', function() {
  // Assertions here
});
```

### pm.expect()

Create Chai-style expectations for assertions.

```javascript
pm.expect(value).to.equal(expected);
pm.expect(value).to.not.equal(expected);
pm.expect(value).to.be.true;
pm.expect(value).to.be.false;
pm.expect(value).to.be.null;
pm.expect(value).to.be.undefined;
pm.expect(value).to.exist;
pm.expect(value).to.be.a('string');
pm.expect(value).to.be.an('array');
pm.expect(value).to.include(item);
pm.expect(value).to.have.length(n);
pm.expect(value).to.be.above(n);
pm.expect(value).to.be.below(n);
pm.expect(value).to.have.property('key');
```

## Response Object (`pm.response`)

Access HTTP response data:

```javascript
pm.response.code              // Status code (number, e.g., 200)
pm.response.status            // Alias for code
pm.response.responseTime      // Response time in milliseconds
pm.response.headers           // Headers object (lowercase keys)
pm.response.body              // Raw body string
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
```

### Response Assertions

```javascript
pm.response.to.have.status(200);
pm.response.to.have.header('Content-Type');
pm.response.to.have.jsonBody();
```

## Request Object (`pm.request`)

Access request data:

```javascript
pm.request.method            // HTTP method (string)
pm.request.url               // Full URL (string)
pm.request.headers           // Request headers (object)
pm.request.body              // Request body (string, if any)
```

## Environment Variables (`pm.environment`)

Access and modify environment variables:

```javascript
// Get variable
const token = pm.environment.get('auth_token');

// Set variable (persists to environment)
pm.environment.set('auth_token', 'new_token_value');
```

## Variables (`pm.variables`)

Access collection and global variables:

```javascript
// Get variable (searches: environment → collection → global)
const value = pm.variables.get('baseUrl');

// Set variable
pm.variables.set('baseUrl', 'https://api.example.com');
```

**Variable Resolution Order:**
1. Environment variables
2. Collection variables
3. Global variables

## Console Output

Log messages that appear in test results:

```javascript
console.log('Response:', pm.response.json());
console.info('Info message');
console.warn('Warning message');
console.error('Error message');
```

## Examples

### Validate JSON Response

```javascript
pm.test('User has correct fields', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
  pm.expect(json.email).to.include('@');
});
```

### Check Status Codes

```javascript
pm.test('Success response', function() {
  pm.expect(pm.response.code).to.be.below(400);
});
```

### Set Variables from Response

```javascript
// Extract token from response and save to environment
const json = pm.response.json();
pm.environment.set('userId', json.id);
pm.environment.set('token', json.token);
```

### Pre-request Script

Modify request before sending:

```javascript
// Add timestamp header
pm.request.headers['X-Timestamp'] = Date.now().toString();

// Add signature header
const secret = pm.environment.get('secret');
const data = pm.request.body + secret;
pm.request.headers['X-Signature'] = computeHash(data);
```

### Response Time Assertion

```javascript
pm.test('Response time is acceptable', function() {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});
```

### Array Validation

```javascript
pm.test('Returns array of users', function() {
  const users = pm.response.json();
  pm.expect(users).to.be.an('array');
  pm.expect(users).to.have.length.above(0);
  pm.expect(users[0]).to.have.property('id');
});
```

### Header Validation

```javascript
pm.test('Has Content-Type header', function() {
  pm.response.to.have.header('Content-Type');
  pm.expect(pm.response.headers['content-type']).to.include('application/json');
});
```

## Limitations

QuickJS supports ES2020 features with some limitations:

- **No ES2021+ features**: No optional chaining (`?.`), nullish coalescing (`??`), etc.
- **No Node.js APIs**: No `require()`, `fs`, `http`, etc.
- **Sandboxed**: No filesystem or network access
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` (headers, body)
- Can access `pm.environment` and `pm.variables`
- Cannot access `pm.response` (request hasn't been sent yet)

### Test Scripts (Post-request)

- Execute after receiving the HTTP response
- Can access `pm.request` and `pm.response`
- Can access `pm.environment` and `pm.variables`
- Test results are included in the response

### Load Test Scripts

- Test scripts in load tests are executed **deferred** (after test completion)
- Only a sample of responses are validated (configurable)
- Results are aggregated and reported in the final report

## Error Handling

Script errors are caught and reported:

```javascript
// If script throws, error is captured
try {
  const json = pm.response.json();
} catch (e) {
  // Error is reported in test results
}
```

Test failures don't stop script execution - all tests run and results are collected.

## Best Practices

1. **Use descriptive test names**: `pm.test('Status code is 200', ...)`
2. **Validate structure before accessing**: Check if JSON exists before accessing properties
3. **Use environment variables**: Store sensitive data in environments, not scripts
4. **Keep scripts simple**: Complex logic should be in your application code
5. **Log debugging info**: Use `console.log()` to debug script issues

## API Reference

For complete API documentation, see the [Scripting Completions API](../api-reference.md#scripting) which lists all available `pm.*` functions and properties.
