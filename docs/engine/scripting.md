# Vayu Scripting Guide

QuickJS-based JavaScript for pre-request and test scripts.

## Quick Start

```javascript
// Test script
pm.test('Status is 200', function() {
  pm.expect(pm.response.code).to.equal(200);
});
```

## The `pm` Object

### Response (`pm.response`)

```javascript
pm.response.code              // Status code (number)
pm.response.status            // Alias for code
pm.response.headers           // Headers (object, lowercase keys)
pm.response.body              // Raw body (string)
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
pm.response.time              // Response time (ms)
```

### Request (`pm.request`)

```javascript
pm.request.method             // HTTP method
pm.request.url                // Full URL
pm.request.headers            // Request headers
pm.request.body               // Request body
```

### Environment (`pm.environment`)

```javascript
pm.environment.get("key")         // Read variable
pm.environment.set("key", "value") // Set variable
```

### Variables (`pm.variables`)

```javascript
pm.variables.get("key")           // Get resolved variable
pm.variables.set("key", "value")  // Set variable
```

## Assertions

### pm.test()

```javascript
pm.test('Test name', function() {
  // assertions here
});
```

### pm.expect()

```javascript
pm.expect(value).to.equal(expected)
pm.expect(value).to.not.equal(expected)
pm.expect(value).to.be.true
pm.expect(value).to.be.false
pm.expect(value).to.be.null
pm.expect(value).to.be.undefined
pm.expect(value).to.be.a('string')
pm.expect(value).to.be.an('array')
pm.expect(value).to.include(item)
pm.expect(value).to.have.length(n)
pm.expect(value).to.be.above(n)
pm.expect(value).to.be.below(n)
pm.expect(value).to.have.property('key')
```

## Examples

### Validate JSON Response

```javascript
pm.test('User has correct fields', function() {
  var json = pm.response.json();
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
var json = pm.response.json();
pm.environment.set('userId', json.id);
pm.environment.set('token', json.token);
```

### Pre-request Script

```javascript
// Add timestamp to request
pm.request.headers['X-Timestamp'] = Date.now().toString();

// Compute signature
var data = pm.request.body + pm.environment.get('secret');
pm.request.headers['X-Signature'] = computeHash(data);
```
