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

Vayu's killer feature: run the same request at massive scale.

### Starting a Load Test

1. Configure your request normally
2. Click **Vayu** button (lightning bolt icon)
3. Configure load test:
   ```
   Duration:    60 seconds
   Concurrency: 100 connections
   Ramp-up:     10 seconds
   ```
4. Click **Start Test**

### Load Test Configuration

| Setting | Description | Example |
|---------|-------------|---------|
| Duration | How long to run | `60s`, `5m` |
| Concurrency | Parallel connections | `100` |
| Ramp-up | Time to reach full load | `10s` |
| RPS Limit | Max requests per second | `5000` |

### Reading Results

```
┌─────────────────────────────────────────────────────────────────┐
│  Load Test Results                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Duration:        60.0s          Total Requests:     589,234    │
│  Avg RPS:         9,820          Success Rate:       99.79%     │
│                                                                 │
│  Latency (ms)                                                   │
│  ─────────────────────────────────────────────────────────────  │
│  min      avg      p50      p90      p95      p99      max      │
│  0.8      10.2     8.5      18.3     25.7     45.2     234.5    │
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

The Vayu CLI can run requests without the GUI.

### Basic Usage

```bash
# Run a single request
vayu-cli run request.json

# Run with environment
vayu-cli run request.json --env production.json

# Run collection
vayu-cli run-collection ./my-api/

# Load test
vayu-cli load request.json --concurrency 100 --duration 60s
```

### Output Formats

```bash
# JSON output
vayu-cli run request.json --format json

# JUnit XML (for CI)
vayu-cli run-collection ./my-api/ --format junit --output results.xml

# TAP format
vayu-cli run-collection ./my-api/ --format tap
```

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
