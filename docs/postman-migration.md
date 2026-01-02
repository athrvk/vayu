# Postman to Vayu Migration Guide

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

Vayu is designed to be **Postman-compatible**. This guide covers:

1. Importing Postman Collections
2. Migrating Environments
3. Script compatibility (pm.* API)
4. Feature differences

---

## Importing Collections

### Supported Formats

| Format | Version | Support |
|--------|---------|---------|
| Postman Collection | v2.1 | ✅ Full |
| Postman Collection | v2.0 | ✅ Full |
| Postman Collection | v1.0 | ⚠️ Auto-converted |
| OpenAPI/Swagger | 3.x | ✅ Full |
| OpenAPI/Swagger | 2.0 | ✅ Full |
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

# Import from URL
vayu-cli import https://api.example.com/collection.json

# Import OpenAPI spec
vayu-cli import openapi.yaml --format openapi
```

### Collection Structure Mapping

```
Postman                          Vayu
─────────────────────────────────────────────────────
Collection                   →   Collection
├── Info                     →   metadata.json
├── Item[] (folders)         →   folders/
│   ├── Item[] (requests)    →   requests/
│   └── Item[] (nested)      →   folders/ (nested)
├── Variable[]               →   variables.json
├── Auth                     →   auth.json
└── Event[] (scripts)        →   scripts/
```

### Vayu Collection Format

```
my-collection/
├── metadata.json           # Collection info
├── variables.json          # Collection variables
├── auth.json              # Default auth config
├── scripts/
│   ├── pre-request.js     # Collection-level pre-script
│   └── post-response.js   # Collection-level post-script
├── folders/
│   └── users/
│       ├── folder.json    # Folder metadata
│       └── requests/
│           ├── create-user.json
│           ├── get-user.json
│           └── delete-user.json
└── requests/              # Root-level requests
    └── health-check.json
```

**Request File Example (`create-user.json`):**

```json
{
  "id": "req_abc123",
  "name": "Create User",
  "method": "POST",
  "url": "{{baseUrl}}/users",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "mode": "json",
    "content": {
      "name": "{{userName}}",
      "email": "{{userEmail}}"
    }
  },
  "auth": {
    "type": "bearer",
    "bearer": "{{authToken}}"
  },
  "scripts": {
    "pre": "pm.variables.set('userName', 'John Doe');",
    "post": "pm.test('Created', () => pm.response.code === 201);"
  }
}
```

---

## Migrating Environments

### Postman Environment Format

```json
{
  "id": "env_123",
  "name": "Production",
  "values": [
    {
      "key": "baseUrl",
      "value": "https://api.example.com",
      "type": "default",
      "enabled": true
    },
    {
      "key": "apiKey",
      "value": "secret123",
      "type": "secret",
      "enabled": true
    }
  ]
}
```

### Vayu Environment Format

```json
{
  "id": "env_123",
  "name": "Production",
  "variables": {
    "baseUrl": {
      "value": "https://api.example.com",
      "secret": false,
      "enabled": true
    },
    "apiKey": {
      "value": "secret123",
      "secret": true,
      "enabled": true
    }
  }
}
```

### Import Command

```bash
# Import Postman environment
vayu-cli import-env postman-environment.json --output ./environments/

# Import multiple environments
vayu-cli import-env ./postman-envs/*.json --output ./environments/
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
| `pm.globals.get()` | ✅ | |
| `pm.globals.set()` | ✅ | |
| `pm.collectionVariables.get()` | ✅ | |
| `pm.collectionVariables.set()` | ✅ | |
| `pm.test()` | ✅ | |
| `pm.expect()` | ✅ | Chai-style assertions |
| `console.log()` | ✅ | |
| `console.info()` | ✅ | |
| `console.warn()` | ✅ | |
| `console.error()` | ✅ | |

### Partially Supported APIs

| Postman API | Vayu Support | Notes |
|-------------|--------------|-------|
| `pm.sendRequest()` | ⚠️ | Sync only in Design Mode |
| `pm.cookies` | ⚠️ | Read-only |
| `pm.info` | ⚠️ | Basic fields only |
| `xml2Json()` | ⚠️ | Limited XML support |

### Not Supported (Yet)

| Postman API | Status | Workaround |
|-------------|--------|------------|
| `pm.visualizer` | ❌ | Use Dashboard UI |
| `pm.execution` | ❌ | N/A |
| `postman.setNextRequest()` | ❌ | Use workflows |
| External libraries (lodash, etc.) | ❌ | Use native JS |

### Script Migration Examples

**Postman Script:**
```javascript
// Using Postman's built-in chai
pm.test("Response is valid", function() {
    var jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data).to.have.property('id');
    pm.expect(jsonData.data.id).to.be.a('number');
});

// Setting next request (NOT SUPPORTED)
postman.setNextRequest("Get User Details");
```

**Vayu Equivalent:**
```javascript
// Same syntax works!
pm.test("Response is valid", function() {
    var jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data).to.have.property('id');
    pm.expect(jsonData.data.id).to.be.a('number');
});

// For sequential requests, use Vayu Workflows (separate feature)
```

---

## Authentication Migration

### Supported Auth Types

| Auth Type | Postman | Vayu |
|-----------|---------|------|
| No Auth | ✅ | ✅ |
| API Key | ✅ | ✅ |
| Bearer Token | ✅ | ✅ |
| Basic Auth | ✅ | ✅ |
| Digest Auth | ✅ | ✅ |
| OAuth 1.0 | ✅ | ✅ |
| OAuth 2.0 | ✅ | ✅ |
| AWS Signature | ✅ | ✅ |
| NTLM | ✅ | ⚠️ (Windows only) |
| Hawk | ✅ | ❌ |
| Akamai EdgeGrid | ✅ | ❌ |

### OAuth 2.0 Configuration

```json
{
  "auth": {
    "type": "oauth2",
    "oauth2": {
      "grantType": "authorization_code",
      "authUrl": "https://auth.example.com/authorize",
      "tokenUrl": "https://auth.example.com/token",
      "clientId": "{{clientId}}",
      "clientSecret": "{{clientSecret}}",
      "scope": "read write",
      "state": "random_state",
      "useBrowser": true
    }
  }
}
```

---

## Body Types Migration

| Postman Mode | Vayu Mode | Notes |
|--------------|-----------|-------|
| `raw` (JSON) | `json` | Parsed and validated |
| `raw` (Text) | `text` | Plain text |
| `raw` (XML) | `xml` | XML string |
| `raw` (JavaScript) | `text` | No special handling |
| `raw` (HTML) | `text` | No special handling |
| `form-data` | `formdata` | Supports files |
| `x-www-form-urlencoded` | `form` | URL encoded |
| `binary` | `binary` | File upload |
| `GraphQL` | `graphql` | Query + variables |

### GraphQL Example

**Postman:**
```json
{
  "body": {
    "mode": "graphql",
    "graphql": {
      "query": "query GetUser($id: ID!) { user(id: $id) { name email } }",
      "variables": "{ \"id\": \"123\" }"
    }
  }
}
```

**Vayu:**
```json
{
  "body": {
    "mode": "graphql",
    "content": {
      "query": "query GetUser($id: ID!) { user(id: $id) { name email } }",
      "variables": {
        "id": "123"
      }
    }
  }
}
```

---

## Feature Comparison

### What Vayu Does Better

| Feature | Postman | Vayu |
|---------|---------|------|
| **Load Testing** | Requires paid cloud | Built-in, local, free |
| **Performance** | ~100 RPS max | 50,000+ RPS |
| **Memory Usage** | ~500MB idle | ~50MB (engine) |
| **Offline Mode** | Limited | Full offline |
| **Open Source** | ❌ | ✅ |
| **Data Privacy** | Cloud sync | Local-only |

### What Postman Does Better (For Now)

| Feature | Postman | Vayu |
|---------|---------|------|
| **Team Collaboration** | Real-time sync | Git-based (planned) |
| **API Documentation** | Auto-generated | Manual (planned) |
| **Mock Servers** | Built-in | Planned |
| **Monitors** | Cloud-based | Local only |
| **Public API Network** | Extensive | N/A |

---

## Migration Checklist

### Before Migration

- [ ] Export all collections from Postman (Collection v2.1 format)
- [ ] Export all environments
- [ ] Document any external library usage (lodash, moment, etc.)
- [ ] Note any `postman.setNextRequest()` usage
- [ ] Backup any local Postman data

### During Migration

- [ ] Import collections one-by-one
- [ ] Review import warnings/errors
- [ ] Test each request in Design Mode
- [ ] Verify scripts execute correctly
- [ ] Check variable substitution

### After Migration

- [ ] Run full collection to verify
- [ ] Test load testing capabilities
- [ ] Set up environments in Vayu
- [ ] Document any workarounds needed
- [ ] Archive Postman collections

---

## Troubleshooting

### Common Issues

**Issue: Scripts using `require()` fail**
```
Error: require is not defined
```
**Solution:** Vayu doesn't support Node.js modules. Rewrite using native JavaScript.

---

**Issue: `postman.setNextRequest()` not working**
```
Error: postman.setNextRequest is not a function
```
**Solution:** Use Vayu Workflows feature instead (see Workflows documentation).

---

**Issue: Variables not substituting**
```
Request URL: {{baseUrl}}/users (literal)
```
**Solution:** Ensure environment is selected. Check variable name spelling.

---

**Issue: Response body shows as raw text**
```
Expected JSON, got string
```
**Solution:** Check `Content-Type` header. Use `pm.response.json()` explicitly.

---

### Getting Help

- **Documentation:** [docs.vayu.dev](https://docs.vayu.dev)
- **GitHub Issues:** [github.com/vayu/vayu/issues](https://github.com/vayu/vayu/issues)
- **Discord:** [discord.gg/vayu](https://discord.gg/vayu)

---

*← [API Reference](api-reference.md) | [Getting Started](getting-started.md) →*
