# Postman to Vayu Migration Guide

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

Vayu is designed to be **Postman-compatible**. This guide covers importing collections, migrating environments, and understanding script compatibility.

---

## Importing Collections

### Supported Formats

| Format | Version | Support |
|--------|---------|---------|
| Postman Collection | v2.1 | ✅ Full |
| Postman Collection | v2.0 | ✅ Full |
| OpenAPI/Swagger | 3.x | ✅ Full |
| HAR | 1.2 | ✅ Full |
| cURL | - | ✅ Full |

### How to Import

#### Via UI

1. Click **File → Import** (or `Cmd+I` / `Ctrl+I`)
2. Select your `.json` collection file
3. Review the import preview
4. Click **Import**

#### Via CLI

```bash
# Import a Postman collection
vayu-cli import postman-collection.json --output ./collections/

# Import OpenAPI spec
vayu-cli import openapi.yaml --format openapi
```

---

## Script Compatibility

### Fully Supported APIs

| Postman API | Vayu Support | Notes |
|-------------|--------------|-------|
| `pm.response.code` | ✅ | |
| `pm.response.status` | ✅ | |
| `pm.response.headers` | ✅ | |
| `pm.response.body` | ✅ | Parsed if JSON |
| `pm.response.text()` | ✅ | |
| `pm.response.json()` | ✅ | |
| `pm.response.responseTime` | ✅ | |
| `pm.request.method` | ✅ | |
| `pm.request.url` | ✅ | |
| `pm.request.headers` | ✅ | |
| `pm.request.body` | ✅ | |
| `pm.variables.get()` | ✅ | |
| `pm.variables.set()` | ✅ | |
| `pm.environment.get()` | ✅ | |
| `pm.environment.set()` | ✅ | |
| `pm.test()` | ✅ | |
| `pm.expect()` | ✅ | Chai-style |
| `console.log()` | ✅ | |

### Example Script

Your existing Postman scripts work in Vayu:

```javascript
pm.test("Response is valid", function() {
    var jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.id).to.exist;
});

pm.variables.set("userId", pm.response.json().id);
```

---

## Authentication Migration

### Supported Auth Types

| Auth Type | Support |
|-----------|---------|
| API Key | ✅ |
| Bearer Token | ✅ |
| Basic Auth | ✅ |
| Digest Auth | ✅ |
| OAuth 2.0 | ✅ |
| AWS Signature | ✅ |

### Example: OAuth 2.0

```json
{
  "auth": {
    "type": "oauth2",
    "oauth2": {
      "grantType": "authorization_code",
      "authUrl": "https://auth.example.com/authorize",
      "tokenUrl": "https://auth.example.com/token",
      "clientId": "{{clientId}}",
      "clientSecret": "{{clientSecret}}"
    }
  }
}
```

---

## Feature Comparison

### What Vayu Does Better

| Feature | Vayu | Notes |
|---------|------|-------|
| **Load Testing** | Built-in, free | 50,000+ RPS capable |
| **Performance** | 10x faster | Event-driven engine |
| **Data Privacy** | Local-only | No cloud sync |
| **Open Source** | Yes | Full source access |

### Feature Parity

| Feature | Status |
|---------|--------|
| Collections | ✅ Full support |
| Environments | ✅ Full support |
| Pre-request scripts | ✅ Full support |
| Test assertions | ✅ Full support |
| Variable substitution | ✅ Full support |

---

## Migration Checklist

### Before Migration

- [ ] Export all collections from Postman
- [ ] Export all environments
- [ ] Note any external library usage

### During Migration

- [ ] Import collections
- [ ] Test requests in Design Mode
- [ ] Verify script execution
- [ ] Check variable substitution

### After Migration

- [ ] Run full collection tests
- [ ] Set up environments
- [ ] Test load testing features

---

## Troubleshooting

### Scripts using external libraries

**Problem:** `require()` not available

**Solution:** Vayu doesn't support Node.js modules. Use native JavaScript instead.

---

### Variables not substituting

**Problem:** `{{baseUrl}}` appears literal in request

**Solution:** Ensure environment is selected and variable names match exactly.

---

### Response body is text, not JSON

**Problem:** `pm.response.json()` throws error

**Solution:** Check `Content-Type` header is `application/json`.

---

*See: [Getting Started](../getting-started.md) | [Architecture](../architecture.md) →*
