# Vayu Frontend - Component Specifications

**Version:** 1.0  
**Last Updated:** January 3, 2026

---

## 📐 Component Hierarchy

```
<App />
├─ <Shell />
│  ├─ <Sidebar />
│  │  ├─ <CollectionsTab />
│  │  │  ├─ <CollectionTree /> (nested folders)
│  │  │  └─ [+ New Collection] button
│  │  ├─ <HistoryTab />
│  │  │  ├─ <HistoryList /> (searchable, filterable)
│  │  │  └─ <HistoryDetail /> (when viewing a run)
│  │  └─ <SettingsTab />
│  │     ├─ <GeneralSettings />
│  │     ├─ <EnvironmentManager />
│  │     └─ <EngineStatus />
│  │
│  └─ <MainContent />
│     ├─ <WelcomeScreen /> (initial)
│     ├─ <RequestBuilder />
│     │  ├─ <RequestForm />
│     │  └─ <ResponseViewer />
│     ├─ <LoadTestDashboard />
│     │  ├─ <MetricsPanel />
│     │  ├─ <ChartsSection />
│     │  └─ <ErrorBreakdown />
│     └─ <LoadTestDialog /> (config)
│
├─ <Dialogs />
│  ├─ <DeleteConfirmDialog />
│  ├─ <LoadTestConfigDialog />
│  └─ <CascadeDeleteDialog /> (delete request + runs)
│
└─ <StatusBar />
   └─ Connection status, current environment, etc.
```

---

## 🔧 Core Components

### **1. Shell (Layout Container)**

**Path:** `src/components/Shell.tsx`

**Responsibility:**

- Main app layout with sidebar + content area
- Manages which tab is active in sidebar
- Manages which screen is shown in main content

**Props:**

```typescript
interface ShellProps {
	// No props - uses Zustand stores
}
```

**State (Zustand):**

```typescript
interface AppState {
	activeSidebarTab: "collections" | "history" | "settings";
	setActiveSidebarTab: (tab) => void;

	activeScreen: "welcome" | "request-builder" | "dashboard" | "history-detail";
	setActiveScreen: (screen) => void;

	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	currentRunId: string | null;
}
```

**Behavior:**

- Sidebar always visible on left
- Main content changes based on activeScreen
- Sidebar nav changes based on activeSidebarTab

---

### **2. CollectionTree (Nested Folder Navigation)**

**Path:** `src/components/Collections/CollectionTree.tsx`

**Responsibility:**

- Display collection hierarchy (nested folders)
- Handle folder expansion/collapse
- Handle request selection
- Support drag-and-drop for reordering

**Props:**

```typescript
interface CollectionTreeProps {
	collections: Collection[];
	selectedRequestId: string | null;
	onSelectRequest: (requestId: string, collectionId: string) => void;
	onNewCollection: () => void;
}
```

**Types:**

```typescript
interface Collection {
	id: string;
	parentId: string | null;
	name: string;
	order: number;
	createdAt: number;
}

interface Request {
	id: string;
	collectionId: string;
	name: string;
	method: string;
	url: string;
	// ... rest of request fields
}
```

**Features:**

- ✅ Expand/collapse folders (toggle icon)
- ✅ Drag-and-drop reorder collections
- ✅ Sort by date (newest/oldest)
- ✅ Right-click context menu (rename, delete, new request)
- ✅ Highlight selected request

**Backend Integration:**

```javascript
// Load collections
GET /collections
→ Build tree structure in frontend

// Reorder collection
PUT /collections/:id
{ parentId: newParent, order: newOrder }

// Create collection
POST /collections
{ name: "New Collection" }
```

---

### **3. RequestBuilder (Form for Request Details)**

**Path:** `src/components/RequestBuilder/RequestBuilder.tsx`

**Responsibility:**

- Display and edit request details
- Handle variable substitution display
- Manage request form state
- Auto-save after 5 seconds

**Props:**

```typescript
interface RequestBuilderProps {
	requestId: string;
	collectionId: string;
}
```

**Sub-Components:**

- `<RequestHeader />` - Method selector + URL input
- `<RequestTabs />` - Tab switcher (Params, Headers, Body, Auth, Scripts)
- `<ParamsEditor />` - Query parameter key-value editor
- `<HeadersEditor />` - Header key-value editor
- `<BodyEditor />` - Body editor (JSON, text, form, binary)
- `<AuthEditor />` - Auth config (type selector + fields)
- `<ScriptsEditor />` - Pre/post script editors
- `<EnvironmentSelector />` - Dropdown for active environment

**State (Zustand):**

```typescript
interface RequestBuilderState {
	currentRequest: Request | null;
	unsavedChanges: boolean;
	autoSaveTimer: NodeJS.Timeout | null;

	setCurrentRequest: (request: Request) => void;
	updateRequest: (updates: Partial<Request>) => void;
	triggerAutoSave: () => void;
	manualSave: () => void;
}
```

**Behavior:**

```javascript
// On component mount
useEffect(() => {
  const request = await fetch(`/requests?collectionId=${collectionId}`)
    .then(r => r.json())
    .then(arr => arr.find(r => r.id === requestId));

  setCurrentRequest(request);
}, [requestId, collectionId]);

// On request field change
const handleFieldChange = (field, value) => {
  updateRequest({ [field]: value });

  // Clear existing timer
  clearTimeout(autoSaveTimer);

  // Start new 5-second timer
  const timer = setTimeout(() => {
    triggerAutoSave();
  }, 5000);

  setAutoSaveTimer(timer);
};

// On save
const triggerAutoSave = async () => {
  await fetch('/requests', {
    method: 'POST',
    body: JSON.stringify(currentRequest)
  });
  setUnsavedChanges(false);
};

// On [Send Request] button
const handleSendRequest = async () => {
  // Save first
  await triggerAutoSave();

  // Execute request
  const response = await fetch('/request', {
    method: 'POST',
    body: JSON.stringify(currentRequest)
  });

  // Store response for viewer
  setResponseData(response);
};

// On [Load Test] button
const handleLoadTest = () => {
  // Save first
  await triggerAutoSave();

  // Open config dialog
  setShowLoadTestDialog(true);
};
```

**Auto-Save Logic:**

```
User types in field
  ↓ (5 seconds of no activity)
  ↓
POST /requests (save to backend)
  ↓
Mark unsavedChanges = false
```

**OR:**

```
User clicks [Send Request] or [Load Test]
  ↓
POST /requests (save immediately if changes)
  ↓
Execute request/load test
```

---

### **4. ResponseViewer (Display Response Data)**

**Path:** `src/components/ResponseViewer/ResponseViewer.tsx`

**Responsibility:**

- Display HTTP response (status, headers, body)
- Show response timing breakdown
- Display test results (pass/fail)
- Format JSON pretty-print

**Props:**

```typescript
interface ResponseViewerProps {
	response: HttpResponse | null;
	isLoading: boolean;
}
```

**Types:**

```typescript
interface HttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: any;
	bodyRaw: string;
	timing: {
		total_ms: number;
		dns_ms: number;
		connect_ms: number;
		tls_ms: number;
		first_byte_ms: number;
		download_ms: number;
	};
	testResults: TestResult[];
	cookies: Cookie[];
}

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}
```

**Sub-Components:**

- `<ResponseHeader />` - Status badge + timing
- `<ResponseTabs />` - Tab switcher (Body, Headers, Cookies, Tests)
- `<BodyViewer />` - Pretty-printed JSON or raw text
- `<HeadersViewer />` - Key-value table
- `<CookiesViewer />` - Cookies list
- `<TestsViewer />` - Test results with pass/fail indicators

**Behavior:**

```javascript
// Display status code with color
const statusColor = (status) => {
	if (status >= 200 && status < 300) return "green";
	if (status >= 300 && status < 400) return "blue";
	if (status >= 400 && status < 500) return "orange";
	if (status >= 500) return "red";
};

// Format timing
const formatTiming = (ms) => `${ms.toFixed(1)}ms`;

// Pretty-print JSON
const prettyJSON = (obj) => JSON.stringify(obj, null, 2);
```

---

### **5. LoadTestDashboard (Grafana-like Metrics)**

**Path:** `src/components/Dashboard/LoadTestDashboard.tsx`

**Responsibility:**

- Display real-time metrics during load test
- Update every ~100ms from SSE stream
- Show charts (RPS, latency, errors)
- Handle stop button

**Props:**

```typescript
interface LoadTestDashboardProps {
	runId: string;
	mode: "running" | "completed";
}
```

**State (Zustand):**

```typescript
interface DashboardState {
	currentMetrics: Metrics | null;
	historicalMetrics: Metrics[];
	testStatus: "running" | "completed" | "stopped" | "failed";

	setCurrentMetrics: (metrics: Metrics) => void;
	addHistoricalMetric: (metric: Metrics) => void;
	setTestStatus: (status) => void;
}
```

**Sub-Components:**

- `<MetricsPanel />` - Key numbers (RPS, errors, total)
- `<LatencyChart />` - Line/area chart
- `<RpsChart />` - RPS over time
- `<ErrorBreakdown />` - Error types table
- `<ProgressBar />` - Test progress (elapsed/duration)
- `<ActionButtons />` - View Request, Stop Test, Run Again, Back

**Behavior:**

```javascript
// On mount, connect to SSE
useEffect(() => {
  const eventSource = new EventSource(`/stats/${runId}`);

  eventSource.addEventListener('metric', (e) => {
    const metric = JSON.parse(e.data);
    setCurrentMetrics(metric);
    addHistoricalMetric(metric);
  });

  eventSource.addEventListener('complete', () => {
    setTestStatus('completed');
    eventSource.close();

    // Fetch final report
    const report = await fetch(`/run/${runId}/report`).then(r => r.json());
    setFinalReport(report);
  });

  return () => eventSource.close();
}, [runId]);

// Update progress bar
const progressPercent = (elapsed / duration) * 100;

// Stop test
const handleStop = async () => {
  await fetch(`/run/${runId}/stop`, { method: 'POST' });
  setTestStatus('stopped');
};
```

**Charts:**

- RPS Over Time: Line chart, updates every 100ms
- Latency Distribution: Histogram or area chart
- Error Rate: Line chart showing error % over time

---

### **6. HistoryList (Run History with Search/Filter)**

**Path:** `src/components/History/HistoryList.tsx`

**Responsibility:**

- Display all past runs (design + load)
- Searchable by request/collection name
- Filterable by type and status
- Sortable by date
- Handle delete operations

**Props:**

```typescript
interface HistoryListProps {
	// No props - uses Zustand
}
```

**State (Zustand):**

```typescript
interface HistoryState {
	runs: Run[];
	searchQuery: string;
	filterType: "all" | "load" | "sanity";
	filterStatus: "all" | "completed" | "failed" | "stopped";
	sortOrder: "newest" | "oldest";

	setSearchQuery: (query: string) => void;
	setFilterType: (type) => void;
	setFilterStatus: (status) => void;
	setSortOrder: (order) => void;
	loadRuns: () => Promise<void>;
	deleteRun: (runId: string) => Promise<void>;
}
```

**Types:**

```typescript
interface Run {
	id: string;
	requestId: string | null;
	environmentId: string | null;
	type: "load" | "design";
	status: "completed" | "failed" | "stopped" | "running";
	startTime: number;
	endTime: number;
	// Populated from report:
	totalRequests?: number;
	rps?: number;
	latency?: number;
}
```

**Behavior:**

```javascript
// Load runs on mount
useEffect(() => {
  const runs = await fetch('/runs').then(r => r.json());
  setRuns(runs);
}, []);

// Filter and search
const filtered = runs
  .filter(r => {
    if (filterType !== 'all') return r.type === (filterType === 'load' ? 'load' : 'design');
    if (filterStatus !== 'all') return r.status === filterStatus;
    if (searchQuery) return r.requestId?.includes(searchQuery) || r.id.includes(searchQuery);
    return true;
  })
  .sort((a, b) => {
    if (sortOrder === 'newest') return b.startTime - a.startTime;
    return a.startTime - b.startTime;
  });

// Delete run
const handleDelete = async (runId) => {
  const confirmed = await showConfirmDialog("Delete this run?");
  if (confirmed) {
    await fetch(`/run/${runId}`, { method: 'DELETE' });
    loadRuns(); // Refresh
  }
};

// View run details
const handleView = (runId) => {
  setActiveScreen('history-detail');
  setSelectedRunId(runId);
};
```

**UI:**

```
[Search box] [Type filter] [Status filter] [Sort dropdown]
─────────────────────────────────────────────────────────
Load Test  │ GET Users      │ 2026-01-03  │ 9,820 RPS
Type: load │ Completed      │ 14:30       │ [View] [Delete]
─────────────────────────────────────────────────────────
Sanity     │ POST Create... │ 2026-01-03  │ 201 OK
Type: design│ Completed     │ 14:25       │ [View] [Delete]
```

---

### **7. EnvironmentManager (Manage Variables)**

**Path:** `src/components/Settings/EnvironmentManager.tsx`

**Responsibility:**

- List all environments
- Edit environment variables
- Create/delete environments
- Set active environment

**Props:**

```typescript
interface EnvironmentManagerProps {
	// No props - uses Zustand
}
```

**State (Zustand):**

```typescript
interface EnvironmentState {
	environments: Environment[];
	activeEnvironmentId: string | null;

	loadEnvironments: () => Promise<void>;
	setActiveEnvironment: (id: string) => void;
	saveEnvironment: (env: Environment) => Promise<void>;
	deleteEnvironment: (id: string) => Promise<void>;
}
```

**Types:**

```typescript
interface Environment {
	id: string;
	name: string;
	variables: Record<string, string>;
	updatedAt: number;
}
```

**Behavior:**

```javascript
// Load environments
useEffect(() => {
  const envs = await fetch('/environments').then(r => r.json());
  setEnvironments(envs);
}, []);

// Save environment changes
const handleSave = async (env) => {
  await fetch('/environments', {
    method: 'POST',
    body: JSON.stringify(env)
  });
  loadEnvironments();
};

// Delete environment
const handleDelete = async (envId) => {
  const confirmed = await showConfirmDialog("Delete this environment?");
  if (confirmed) {
    await fetch(`/environments/${envId}`, { method: 'DELETE' });
    loadEnvironments();
  }
};
```

---

### **8. LoadTestConfigDialog (Configuration)**

**Path:** `src/components/Dialogs/LoadTestConfigDialog.tsx`

**Responsibility:**

- Collect load test configuration
- Validate settings
- Start load test on submit

**Props:**

```typescript
interface LoadTestConfigDialogProps {
	requestId: string;
	environmentId: string;
	onStart: (config: LoadTestConfig) => void;
	onCancel: () => void;
}
```

**Types:**

```typescript
interface LoadTestConfig {
	mode: "constant";
	duration: string; // "30s", "5m", "1h"
	targetRps?: number;
	concurrency?: number;
	rampUpTime?: string;
	timeout?: number;
}
```

**Validation:**

```javascript
const validate = (config) => {
	if (!config.duration) return { error: "Duration required" };
	if (!config.targetRps && !config.concurrency) {
		return { error: "Specify either Target RPS or Concurrency" };
	}
	if (config.targetRps && config.concurrency) {
		return { error: "Choose one: Target RPS OR Concurrency" };
	}
	return { valid: true };
};
```

**Behavior:**

```javascript
const handleStart = async () => {
	const validation = validate(config);
	if (!validation.valid) {
		showError(validation.error);
		return;
	}

	// POST /run with config
	const response = await fetch("/run", {
		method: "POST",
		body: JSON.stringify({
			request: currentRequest,
			...config,
			environmentId: activeEnvironmentId,
		}),
	});

	const { runId } = await response.json();
	onStart(runId);
};
```

---

## 🔗 Component Communication Flow

```
RequestBuilder (user fills form)
   ↓ updateRequest()
   ↓ Zustand store
   ↓ [Send Request] clicked
   ↓ useEngine hook
   ↓ POST /request
   ↓
ResponseViewer (displays response)

RequestBuilder
   ↓ [Load Test] clicked
   ↓
LoadTestConfigDialog (gets config)
   ↓ [Start Load Test] clicked
   ↓ POST /run (with config)
   ↓ Returns runId
   ↓
LoadTestDashboard
   ↓ GET /stats/:id (SSE)
   ↓
Continuously update metrics
   ↓ event: complete
   ↓
Fetch GET /run/:id/report
   ↓
Show final dashboard with report data
```

---

## 📊 Summary of Components

| Component            | Path                              | Primary Responsibility  |
| -------------------- | --------------------------------- | ----------------------- |
| Shell                | Shell.tsx                         | App layout & routing    |
| CollectionTree       | Collections/CollectionTree.tsx    | Navigate collections    |
| RequestBuilder       | RequestBuilder/RequestBuilder.tsx | Edit request definition |
| ResponseViewer       | ResponseViewer/ResponseViewer.tsx | Display response        |
| LoadTestDashboard    | Dashboard/LoadTestDashboard.tsx   | Show real-time metrics  |
| HistoryList          | History/HistoryList.tsx           | View past runs          |
| EnvironmentManager   | Settings/EnvironmentManager.tsx   | Manage variables        |
| LoadTestConfigDialog | Dialogs/LoadTestConfigDialog.tsx  | Configure load test     |

All components use **Zustand** for state management and **custom hooks** (useEngine, useSSE) for backend communication.

Ready for integration plan!
