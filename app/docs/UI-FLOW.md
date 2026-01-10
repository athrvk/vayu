# Vayu Frontend - Complete UI Flow

**Version:** 1.0  
**Last Updated:** January 3, 2026  
**Status:** Ready for Phase 1 Implementation

---

## 📱 App Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│              VAYU DESKTOP APPLICATION                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  LEFT SIDEBAR (Always Visible)                         │
│  ├─ Collections Tab (default)                          │
│  ├─ History Tab                                        │
│  └─ Settings Tab                                       │
│                                                         │
│  MAIN CONTENT AREA (Dynamic)                           │
│  ├─ Welcome Screen (initial state)                     │
│  ├─ Request Builder + Response Viewer                  │
│  ├─ Grafana Dashboard (Load Test)                      │
│  ├─ History List + Detail View                         │
│  └─ Settings Panel                                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 FLOW 1: APP STARTUP

```
[User launches Vayu.app]
     ↓
[Electron loads React]
     ↓
[Sidecar manager spawns C++ engine]
     ↓
[GET /health to verify engine running]
     ↓
[Fetch initial data in parallel:]
   ├─ GET /config (engine capabilities)
   ├─ GET /collections (sidebar tree)
   └─ GET /environments (dropdown list)
     ↓
[Display main app shell]
```

**Initial UI State:**

```
┌────────────────────────────────────────────────────┐
│ Vayu                                           ─ □ x │
├────────────────────────────────────────────────────┤
│ Left: Collections │ History │ Settings             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│ [+ New Collection]                                 │
│ 📁 My API                                          │
│   ├─ 📁 Users                                      │
│   │  ├─ GET List Users                            │
│   │  ├─ POST Create User                          │
│   │  └─ DELETE User                               │
│   └─ 📁 Posts                                      │
│      └─ GET Posts                                 │
│                                                    │
│ 📁 Test API                                        │
│   └─ GET Health Check                             │
│                         │  Main: Welcome Screen    │
│                         │                          │
│                         └──────────────────────────┤
│                            Welcome to Vayu!       │
│                            Select a request...     │
└────────────────────────────────────────────────────┘
```

---

## 🔄 FLOW 2: USER CLICKS A REQUEST (Request Builder View)

**Trigger:** User clicks "GET List Users" in sidebar

**Actions:**

- Query local Zustand state for collections
- Fetch `GET /requests?collectionId=col_123`
- Find request in results
- Display Request Builder with saved details

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ [Sidebar: Collections visible on left]                    │
│                                                            │
│ MAIN CONTENT: REQUEST BUILDER                             │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ GET List Users                                   [x] │  │
│ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  │
│ │                                                      │  │
│ │ METHOD: [GET ▼]  URL: [https://api.../users    ] │  │
│ │                                                      │  │
│ │ Tabs: Params | Headers | Body | Auth | Scripts   │  │
│ │                                                      │  │
│ │ [Currently on: Headers tab]                        │  │
│ │ ───────────────────────────────────────────────    │  │
│ │ Key              │ Value                           │  │
│ │ ─────────────────┼──────────────────────────────   │  │
│ │ Authorization    │ Bearer {{token}}                │  │
│ │ Accept           │ application/json                │  │
│ │ [+ Add Header]                                     │  │
│ │                                                      │  │
│ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  │
│ │                                                      │  │
│ │ Environment: [Development ▼]                       │  │
│ │                                                      │  │
│ │ [Send Request]  [Load Test]  [Save]  [Delete]     │  │
│ │                                                      │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                            │
│ RESPONSE VIEWER (Empty until request sent)                │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ Response                                             │  │
│ │ (No request sent yet)                              │  │
│ │                                                      │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Backend Calls:**

```javascript
GET /requests?collectionId=col_123
↓
Response: [{id: "req_abc", name: "GET List Users", method: "GET", ...}]
↓
Display request builder with values
```

---

## 🎯 FLOW 3A: USER CLICKS "SEND REQUEST" (Sanity Check)

**Trigger:** User clicks [Send Request] button

**Actions:**

```
1. Validate request (URL not empty, valid method)
2. Prepare request object from form
3. Substitute variables from active environment
4. POST /request
5. Display response
6. Run post-scripts and show test results
```

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ Left: Request Builder (same as before)                    │
│                                                            │
│ Right: RESPONSE VIEWER (NOW SHOWING DATA)                 │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ Response              [200 OK ▼]  [45ms]            │  │
│ │                                                      │  │
│ │ Tabs: Body | Headers | Cookies | Tests              │  │
│ │                                                      │  │
│ │ [Currently on: Body tab]                            │  │
│ │ ───────────────────────────────────────────────      │  │
│ │ {                                                    │  │
│ │   "users": [                                         │  │
│ │     {"id": 1, "name": "Alice"},                      │  │
│ │     {"id": 2, "name": "Bob"}                         │  │
│ │   ]                                                  │  │
│ │ }                                                    │  │
│ │                                                      │  │
│ │ [Tests tab shows:]                                  │  │
│ │ ✓ Status is 200 - PASS                              │  │
│ │ ✓ Response has users - PASS                         │  │
│ │                                                      │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Backend Call:**

```javascript
POST /request
{
  method: "GET",
  url: "https://api.../users",
  headers: { Authorization: "Bearer prod_token" },
  environmentId: "env_prod"
}
↓
Response: {
  status: 200,
  body: {...},
  timing: { total_ms: 45 },
  testResults: [{ name: "Status is 200", passed: true }, ...]
}
↓
Auto-save as "design" run in backend DB
```

**Auto-Save Behavior:**

- Backend automatically creates a run record
- Type: "design"
- User can view this in History tab later

---

## 💥 FLOW 3B: USER CLICKS "LOAD TEST" (Performance Testing)

### **Step 1: Load Test Config Dialog**

**Trigger:** User clicks [Load Test] button

```
┌────────────────────────────────────────────────────┐
│   LOAD TEST CONFIGURATION                          │
├────────────────────────────────────────────────────┤
│                                                    │
│ Mode:          [Constant ▼]                        │
│                                                    │
│ DURATION MODE:                                     │
│ Duration:      [60 ▼] seconds                      │
│ Target RPS:    [1000]  (optional, leave for max)   │
│                                                    │
│ OR CONCURRENCY MODE:                               │
│ Concurrency:   [100] connections                   │
│                                                    │
│ Optional Settings:                                 │
│ Ramp Up Time:  [10s]                               │
│ Timeout:       [5000ms]                            │
│                                                    │
│ [Cancel]  [Start Load Test]                        │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Mode Selection Logic:**

```
If user fills in Target RPS → Use rate-limited mode
If user fills in Concurrency → Use concurrency-based mode
If both empty → Error: "Select either RPS or Concurrency"
```

### **Step 2: Load Test Running - Grafana Dashboard**

**Trigger:** User clicks [Start Load Test]

**Actions:**

```
1. Validate config
2. POST /run with load config
3. Receive 202 Accepted + runId
4. Open GET /stats/:runId (SSE) to stream metrics
5. Update UI every 100ms as metrics arrive
6. Update progress bar based on elapsed/duration
```

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ LOAD TEST DASHBOARD (Grafana-like)                        │
│                                                            │
│ Load Test: GET List Users                                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Status: [● RUNNING]  Elapsed: 45s / 60s                   │
│ Progress: ████████████░░░░░░░░░░░░░░░░░░░░░░ 75%          │
│                                                            │
│ [View Request/Response]  [Pause]  [Stop Test]            │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ KEY METRICS (Real-time, updating every ~100ms):          │
│                                                            │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│ │ RPS      │  │ Errors   │  │ Total    │  │ Avg      │  │
│ │ 9,845    │  │ 12 (0.2%)│  │ 589,234  │  │ 12.3ms   │  │
│ └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ LATENCY PERCENTILES (ms)                           │   │
│ │ P50: 8.5   P95: 25.7   P99: 45.2  Max: 234.5      │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ RPS OVER TIME - Real-time Chart                    │   │
│ │ [Line chart, updates smoothly]                     │   │
│ │                                                    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ LATENCY DISTRIBUTION - Real-time Chart             │   │
│ │ [Histogram or line chart]                          │   │
│ │                                                    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ERROR BREAKDOWN                                    │   │
│ │ Timeout (504):        8                            │   │
│ │ Connection Failed:    4                            │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Backend Streaming:**

```javascript
// SSE /stats/:runId continuously sends:
event: metric
data: {"name":"rps", "value": 9845, "timestamp": 1704200001000}

event: metric
data: {"name":"error_rate", "value": 0.2, "timestamp": 1704200001000}

// Repeat every ~100ms until:

event: complete
data: {"event":"complete", "runId":"run_123", "status":"completed"}
```

### **Step 2.1: User Clicks "View Request/Response" During Test**

**Trigger:** While test is RUNNING, user clicks [View Request/Response]

**Actions:**

```
1. Fetch GET /request (design run if exists) or display form
2. Fetch sample response from recent successful request
3. Show Postman-like view
4. Dashboard continues updating in background (NOT PAUSED)
```

**UI Output:**

```
[Same as FLOW 3A - Request Builder + Response Viewer]

⚠️ Banner at top: "Load test still running in background"
Button: [Back to Dashboard]

(User clicks [Back to Dashboard] to return to Grafana view)
```

### **Step 3: Load Test Completes**

**Trigger:** Test duration expires or user clicks [Stop Test]

**Actions:**

```
1. SSE sends event: complete
2. Fetch GET /run/:id/report for detailed statistics
3. Update dashboard with final metrics
4. Display completion message
5. Show action buttons
```

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ LOAD TEST DASHBOARD (COMPLETED)                           │
│                                                            │
│ Load Test: GET List Users                                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Status: [✓ COMPLETED]  Duration: 60.5s                    │
│                                                            │
│ [View Request/Response]  [Run Again]  [Export Results]   │
│ [Back to Request Builder]                                 │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ FINAL RESULTS:                                            │
│                                                            │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│ │ RPS      │  │ Errors   │  │ Total    │  │ Avg      │  │
│ │ 9,820    │  │ 1222(0.2%│  │ 589,234  │  │ 10.2ms   │  │
│ └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ FINAL LATENCY (ms)                                 │   │
│ │ Min: 0.8  P50: 8.5  P95: 25.7  P99: 45.2  Max:234.5│  │
│ │                                                    │   │
│ │ [Line/Distribution chart - final state]           │   │
│ │                                                    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ THROUGHPUT                                         │   │
│ │ Sent: 125.4 MB  |  Received: 892.1 MB              │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ STATUS CODES                                       │   │
│ │ 200: 588,012  |  500: 1,222                        │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Backend Call:**

```javascript
GET /run/:id/report
↓
Response: {
  summary: { totalRequests: 589234, ... },
  latency: { min: 0.8, avg: 10.2, p50: 8.5, p95: 25.7, p99: 45.2 },
  statusCodes: { "200": 588012, "500": 1222 },
  errors: { total: 1222, types: { timeout: 800, ... } }
}
↓
Populate dashboard with final values
```

---

## 📚 FLOW 4: USER CLICKS "HISTORY" TAB

**Trigger:** User clicks "History" tab in left sidebar

**Actions:**

```
1. GET /runs (all runs, both design + load)
2. Display list with filtering/search
3. Show metadata: date, type, status, RPS/latency
```

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ Collections | History | Settings                          │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Search: [_____________]  Filter: [All ▼] [Type ▼] [Status ▼]
│                                                            │
│ Run History                                                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ 📊 GET Users              2026-01-03 14:30                │
│    Load Test  |  Completed  |  9,820 RPS  [View] [Delete] │
│                                                            │
│ 📊 Create User            2026-01-03 14:25                │
│    Load Test  |  Completed  |  8,234 RPS  [View] [Delete] │
│                                                            │
│ 📋 My API Collection      2026-01-03 14:20                │
│    Load Test  |  Completed  |  11,245 RPS [View] [Delete] │
│                                                            │
│ 📋 POST Create User       2026-01-03 14:15                │
│    Sanity     |  Completed  |  201 OK     [View] [Delete] │
│                                                            │
│ ❌ DELETE User            2026-01-03 14:10                │
│    Load Test  |  Failed     |  (error)    [View] [Delete] │
│                                                            │
│ [Load More...]                                             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Search/Filter Capabilities (Phase 1):**

- Search by request/collection name
- Filter by type: "All" | "Load Test" | "Sanity Check"
- Filter by status: "All" | "Completed" | "Failed"
- Sort by date (newest first, oldest first)

**User Clicks "View" on a Run:**

```
GET /run/:id/report
↓
Display Grafana dashboard with those metrics (same as FLOW 3B completion)
```

**User Clicks "Delete":**

```
Confirmation dialog:
┌─────────────────────────────────────────┐
│ Delete Run?                             │
├─────────────────────────────────────────┤
│ Are you sure you want to delete this    │
│ run from history?                       │
│                                         │
│ Run: GET Users (2026-01-03 14:30)       │
│                                         │
│ [Cancel]  [Delete]                      │
│                                         │
└─────────────────────────────────────────┘
↓
DELETE /run/:id (backend removes from DB)
↓
Refresh history list
```

---

## ⚙️ FLOW 5: USER CLICKS "SETTINGS" TAB

**Trigger:** User clicks "Settings" tab in left sidebar

**UI Output:**

```
┌────────────────────────────────────────────────────────────┐
│ Vayu                                               ─ □ x   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ Collections | History | Settings                          │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ GENERAL                                                    │
│ ───────────────────────────────────────────────────       │
│ Theme:                [Light] [Dark ◐]  (Dark: Phase 2)    │
│ Default Timeout:      [30000 ms]                           │
│ Follow Redirects:     [✓] Yes                              │
│ Max Redirects:        [10]                                 │
│                                                            │
│ ENVIRONMENTS (Global Variables)                            │
│ ───────────────────────────────────────────────────       │
│ ┌──────────────────────────────────────────────────┐      │
│ │ Environment: [Development ▼]                     │      │
│ │                                                  │      │
│ │ Key              │ Value                    │ [x]│      │
│ ├──────────────────────────────────────────────────┤      │
│ │ baseUrl          │ https://api.dev.example │    │      │
│ │ apiKey           │ sk_test_xxxxx...        │    │      │
│ │ timeout          │ 30000                   │    │      │
│ │ [+ Add Variable] │                         │    │      │
│ └──────────────────────────────────────────────────┘      │
│                                                            │
│ OR:                                                        │
│                                                            │
│ [+ New Environment]   [Edit]  [Delete]                    │
│                                                            │
│ ENGINE STATUS                                              │
│ ───────────────────────────────────────────────────       │
│ Status:               [✓ Connected]                        │
│ Version:              [0.1.0]                              │
│ Workers:              [8]                                  │
│ [Restart Engine]  [View Logs]                             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Settings Features:**

- Edit default timeout
- Manage environments (CRUD)
- View engine status/version
- Dark mode toggle (disabled for Phase 1)
- Manage global variables

**Backend Integration:**

```javascript
// Load environments
GET /environments
↓
Display list for editing

// Save environment changes
POST /environments
{
  id: "env_dev",
  name: "Development",
  variables: { baseUrl: "...", apiKey: "..." }
}
```

---

## 🎯 STATE TRANSITIONS (Summary)

```
WELCOME SCREEN
    ↓ click request or "New Request"
    ↓
REQUEST BUILDER + RESPONSE VIEWER
    ├─ (click [Send Request])
    │  └─ Displays response (auto-saves as design run)
    │
    └─ (click [Load Test])
       └─ Config dialog
          ↓ start test
          ↓
          GRAFANA DASHBOARD (RUNNING)
             ├─ (click [View Request/Response])
             │  └─ Shows Postman-like view
             │     ↓ back
             │     └─ Returns to Grafana
             │
             └─ Test completes
                ↓
                GRAFANA DASHBOARD (COMPLETED)
                   ├─ (click [View Request/Response])
                   │  └─ Shows sample response
                   │
                   ├─ (click [Run Again])
                   │  └─ Back to config dialog
                   │
                   └─ (click [Back to Request Builder])
                      └─ Returns to REQUEST BUILDER
```

---

## 🔄 DATA FLOW DIAGRAM

```
USER ACTION → COMPONENT → ZUSTAND STORE → BACKEND API → DISPLAY

[Click Request]
    ↓
RequestBuilder Component
    ↓
updateSelectedRequest()
    ↓
GET /requests?collectionId=X
    ↓
Display form with values

[Send Request]
    ↓
useEngine hook
    ↓
POST /request
    ↓
Store response in Zustand
    ↓
ResponseViewer renders

[Load Test]
    ↓
LoadTestDialog Component
    ↓
POST /run
    ↓
Store runId in Zustand
    ↓
Dashboard Component
    ↓
useSSE hook
    ↓
GET /stats/:id (SSE)
    ↓
Update metrics every 100ms
```

---

## 📌 KEY BEHAVIORS

### **Auto-Save Behavior**

- Single request execution: Auto-saved as "design" run (no user action needed)
- Request definition changes: Auto-save after 5 seconds of inactivity
  - Or immediately on [Send Request] or [Load Test]
- Load test changes: Auto-save on [Start Load Test]
- Manual save: [Save] button always available for explicit save

### **Environment Substitution**

- All fields (URL, headers, body) support `{{variable}}` syntax
- Substitution happens just before request sent
- If variable not found, show warning but don't block request
- Example: `{{baseUrl}}/api` → `https://api.example.com/api`

### **Request Persistence**

- Auto-save triggers (5s idle, on send, on load test)
- No explicit "unsaved" indicator needed (modern UX)
- User can click [Save] to force save immediately

### **History Management**

- Every execution (design + load) creates a run record
- Backend auto-links run to requestId/environmentId
- User can delete runs individually from History tab
- If user deletes a request, option to cascade-delete its runs (dialog)

### **Stop Test Behavior**

- Click [Stop Test] sends POST /run/:id/stop
- Backend gracefully shuts down (up to 5 seconds)
- Final metrics returned with summary
- Dashboard updates with "stopped" status

---

## ✅ Summary

This UI flow covers:

- ✅ All user journeys (welcome → request → test → history)
- ✅ Real-time data updates (SSE streaming)
- ✅ Error handling (graceful failures)
- ✅ Auto-save behavior (5s + on-action)
- ✅ Environment variable substitution
- ✅ Collection hierarchy (nested folders)
- ✅ History search/filter
- ✅ Load test configuration options
- ✅ Sanity check mode (single request)

Ready for component specification!
