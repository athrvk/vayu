# Vayu Frontend - Data Models & Types

**Version:** 1.0  
**Last Updated:** January 3, 2026

---

## 📋 TypeScript Type Definitions

All types should be created in: `src/types/index.ts`

### **Collection Types**

```typescript
/**
 * Represents a collection (folder) that organizes requests
 */
export interface Collection {
	/** Unique identifier */
	id: string;

	/** Parent collection ID (null for root-level) */
	parentId: string | null;

	/** Display name */
	name: string;

	/** Display order within parent */
	order: number;

	/** Creation timestamp (milliseconds) */
	createdAt: number;
}

/**
 * Tree-structured collection for UI rendering
 */
export interface CollectionNode extends Collection {
	/** Child collections (for nested display) */
	children: CollectionNode[];

	/** Requests in this collection (non-recursive) */
	requests: Request[];
}
```

---

### **Request Types**

```typescript
/**
 * Represents an HTTP request definition
 */
export interface Request {
	/** Unique identifier */
	id: string;

	/** Parent collection ID */
	collectionId: string;

	/** Display name */
	name: string;

	/** HTTP method */
	method: HttpMethod;

	/** Request URL (supports {{variables}}) */
	url: string;

	/** HTTP headers (key-value pairs) */
	headers: Record<string, string>;

	/** Request body (type depends on bodyMode) */
	body: RequestBody;

	/** Authentication configuration */
	auth: AuthConfig;

	/** JavaScript code to run before request */
	preRequestScript: string;

	/** JavaScript code to run after response (tests) */
	postRequestScript: string;

	/** Last modification timestamp */
	updatedAt: number;
}

export type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "DELETE"
	| "PATCH"
	| "HEAD"
	| "OPTIONS";

export interface RequestBody {
	/** Body format: json, text, form, formdata, binary, none */
	mode: "json" | "text" | "form" | "formdata" | "binary" | "none";

	/** Body content (varies by mode) */
	content?: any;
}

export interface AuthConfig {
	/** Auth type: bearer, basic, digest, oauth2, awssig */
	type?: "bearer" | "basic" | "digest" | "oauth2" | "awssig";

	/** Bearer token */
	token?: string;

	/** Basic auth username */
	username?: string;

	/** Basic auth password */
	password?: string;

	/** OAuth 2.0 configuration */
	oauth2?: {
		grantType: string;
		authUrl: string;
		tokenUrl: string;
		clientId: string;
		clientSecret: string;
	};
}
```

---

### **Environment Types**

```typescript
/**
 * Represents a set of variables (environment)
 */
export interface Environment {
	/** Unique identifier */
	id: string;

	/** Display name (e.g., "Production", "Development") */
	name: string;

	/** Variable key-value pairs */
	variables: Record<string, string>;

	/** Last modification timestamp */
	updatedAt: number;
}
```

---

### **Run/Execution Types**

```typescript
/**
 * Represents a single execution (design mode request or load test)
 */
export interface Run {
	/** Unique run identifier (e.g., "run_1704200000000") */
	id: string;

	/** Linked request definition ID (nullable for ad-hoc requests) */
	requestId: string | null;

	/** Linked environment ID (nullable for requests without environment) */
	environmentId: string | null;

	/** Type of run: "design" (single request) or "load" (load test) */
	type: "design" | "load";

	/** Current status */
	status: "pending" | "running" | "completed" | "stopped" | "failed";

	/** JSON snapshot of request configuration */
	configSnapshot: string;

	/** Start timestamp (milliseconds) */
	startTime: number;

	/** End timestamp (milliseconds, null if still running) */
	endTime: number | null;
}

/**
 * Detailed report for a completed run
 */
export interface RunReport {
	/** Summary statistics */
	summary: RunSummary;

	/** Latency analysis */
	latency: LatencyStats;

	/** HTTP status code distribution */
	statusCodes: Record<number, number>;

	/** Error information */
	errors: ErrorStats;

	/** Timing breakdown (if enabled during test) */
	timingBreakdown?: TimingBreakdown;

	/** Slow request analysis (if threshold was set) */
	slowRequests?: SlowRequestStats;
}

export interface RunSummary {
	/** Total requests executed */
	totalRequests: number;

	/** Successful requests (HTTP 2xx/3xx) */
	successfulRequests: number;

	/** Failed requests */
	failedRequests: number;

	/** Error percentage (0-100) */
	errorRate: number;

	/** Total test duration in seconds */
	totalDurationSeconds: number;

	/** Average RPS (requests per second) */
	avgRps: number;
}

export interface LatencyStats {
	/** Minimum latency (ms) */
	min: number;

	/** Maximum latency (ms) */
	max: number;

	/** Average latency (ms) */
	avg: number;

	/** 50th percentile (median) */
	p50: number;

	/** 90th percentile */
	p90: number;

	/** 95th percentile */
	p95: number;

	/** 99th percentile */
	p99: number;
}

export interface ErrorStats {
	/** Total error count */
	total: number;

	/** Errors with detailed information */
	withDetails: number;

	/** Error types and their counts */
	types: Record<string, number>; // e.g., { "timeout": 3, "connection_failed": 2 }
}

export interface TimingBreakdown {
	/** Average DNS lookup time (ms) */
	avgDnsMs: number;

	/** Average TCP connection time (ms) */
	avgConnectMs: number;

	/** Average TLS handshake time (ms) */
	avgTlsMs: number;

	/** Average time to first byte (ms) */
	avgFirstByteMs: number;

	/** Average body download time (ms) */
	avgDownloadMs: number;
}

export interface SlowRequestStats {
	/** Number of requests slower than threshold */
	count: number;

	/** Slow threshold (ms) */
	thresholdMs: number;

	/** Percentage of total requests */
	percentage: number;
}
```

---

### **HTTP Response Types**

```typescript
/**
 * Response from POST /request endpoint
 */
export interface HttpResponse {
	/** HTTP status code */
	status: number;

	/** HTTP status text (e.g., "OK", "Created") */
	statusText: string;

	/** Response headers (lowercase keys) */
	headers: Record<string, string>;

	/** Parsed response body (JSON if applicable) */
	body: any;

	/** Raw response body as string */
	bodyRaw: string;

	/** Request timing breakdown */
	timing: ResponseTiming;

	/** Test assertion results (if post-script exists) */
	testResults?: TestResult[];

	/** Console.log() output from scripts */
	consoleOutput?: string[];

	/** Cookies set by response */
	cookies?: ResponseCookie[];
}

export interface ResponseTiming {
	/** Total request time (ms) */
	total_ms: number;

	/** DNS lookup time (ms) */
	dns_ms: number;

	/** TCP connection time (ms) */
	connect_ms: number;

	/** TLS handshake time (ms) */
	tls_ms: number;

	/** Time to first byte (TTFB) (ms) */
	first_byte_ms: number;

	/** Body download time (ms) */
	download_ms: number;
}

export interface TestResult {
	/** Test name */
	name: string;

	/** Whether test passed */
	passed: boolean;

	/** Error message if failed */
	error?: string;
}

export interface ResponseCookie {
	/** Cookie name */
	name: string;

	/** Cookie value */
	value: string;

	/** Cookie domain */
	domain?: string;

	/** Cookie path */
	path?: string;

	/** Expiration date */
	expires?: string;

	/** HTTP-only flag */
	httpOnly?: boolean;

	/** Secure flag */
	secure?: boolean;
}
```

---

### **Load Test Configuration Types**

```typescript
/**
 * Configuration for a load test
 */
export interface LoadTestConfig {
	/** Load test mode */
	mode: "constant" | "iterations" | "ramp_up";

	/** Test duration (e.g., "30s", "5m", "1h") */
	duration?: string;

	/** Target requests per second */
	targetRps?: number;

	/** Number of concurrent connections */
	concurrency?: number;

	/** Total iterations (for iterations mode) */
	iterations?: number;

	/** Ramp-up duration (e.g., "30s") */
	rampUpDuration?: string;

	/** Starting concurrency level */
	startConcurrency?: number;

	/** Per-request timeout (ms) */
	timeout?: number;

	/** Percentage of successful requests to save (1-100) */
	success_sample_rate?: number;

	/** Save requests slower than this threshold (ms) */
	slow_threshold_ms?: number;

	/** Capture detailed timing breakdown */
	save_timing_breakdown?: boolean;
}

/**
 * Real-time metric event from SSE stream
 */
export interface MetricEvent {
	/** Metric type */
	name: string;

	/** Current value */
	value: number;

	/** Timestamp (milliseconds) */
	timestamp: number;

	/** Run ID */
	runId: string;
}
```

---

### **Backend API Request/Response Types**

```typescript
/**
 * Request body for POST /request endpoint
 */
export interface ExecuteRequestPayload {
	method: HttpMethod;
	url: string;
	headers?: Record<string, string>;
	body?: any;
	auth?: AuthConfig;
	preRequestScript?: string;
	postRequestScript?: string;
	requestId?: string;
	environmentId?: string;
	timeout?: number;
}

/**
 * Request body for POST /run endpoint
 */
export interface StartLoadTestPayload {
	request: ExecuteRequestPayload;
	mode: "constant" | "iterations" | "ramp_up";
	duration?: string;
	targetRps?: number;
	concurrency?: number;
	iterations?: number;
	rampUpDuration?: string;
	startConcurrency?: number;
	timeout?: number;
	success_sample_rate?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	requestId?: string;
	environmentId?: string;
}

/**
 * Response from POST /run endpoint
 */
export interface StartLoadTestResponse {
	/** Unique run identifier */
	runId: string;

	/** Initial status */
	status: "pending" | "running";

	/** URL to stream stats from */
	streamUrl: string;
}

/**
 * Engine configuration from GET /config
 */
export interface EngineConfig {
	/** Number of worker threads */
	workers: number;

	/** Maximum concurrent connections */
	maxConnections: number;

	/** Default request timeout (ms) */
	defaultTimeout: number;

	/** Statistics update interval (ms) */
	statsInterval: number;

	/** QuickJS context pool size */
	contextPoolSize: number;
}
```

---

### **UI State Types (Zustand Stores)**

```typescript
/**
 * Global app state
 */
export interface AppState {
	// Navigation
	activeSidebarTab: "collections" | "history" | "settings";
	setActiveSidebarTab: (tab: AppState["activeSidebarTab"]) => void;

	activeScreen: "welcome" | "request-builder" | "dashboard" | "history-detail";
	setActiveScreen: (screen: AppState["activeScreen"]) => void;

	// Selected items
	selectedCollectionId: string | null;
	setSelectedCollectionId: (id: string | null) => void;

	selectedRequestId: string | null;
	setSelectedRequestId: (id: string | null) => void;

	selectedRunId: string | null;
	setSelectedRunId: (id: string | null) => void;

	// Current load test
	currentRunId: string | null;
	setCurrentRunId: (id: string | null) => void;

	testStatus: "idle" | "running" | "completed" | "stopped" | "failed";
	setTestStatus: (status: AppState["testStatus"]) => void;
}

/**
 * Request builder state
 */
export interface RequestBuilderState {
	currentRequest: Request | null;
	setCurrentRequest: (req: Request | null) => void;

	unsavedChanges: boolean;
	setUnsavedChanges: (changed: boolean) => void;

	responseData: HttpResponse | null;
	setResponseData: (resp: HttpResponse | null) => void;

	isLoadingRequest: boolean;
	setIsLoadingRequest: (loading: boolean) => void;

	isSendingRequest: boolean;
	setIsSendingRequest: (sending: boolean) => void;

	updateRequest: (updates: Partial<Request>) => void;
	saveRequest: () => Promise<void>;
}

/**
 * History/Runs state
 */
export interface HistoryState {
	runs: Run[];
	setRuns: (runs: Run[]) => void;

	searchQuery: string;
	setSearchQuery: (query: string) => void;

	filterType: "all" | "load" | "sanity";
	setFilterType: (type: HistoryState["filterType"]) => void;

	filterStatus: "all" | "completed" | "failed" | "stopped";
	setFilterStatus: (status: HistoryState["filterStatus"]) => void;

	sortOrder: "newest" | "oldest";
	setSortOrder: (order: HistoryState["sortOrder"]) => void;

	loadRuns: () => Promise<void>;
	deleteRun: (runId: string) => Promise<void>;
}

/**
 * Dashboard/Metrics state
 */
export interface DashboardState {
	currentMetrics: Record<string, number> | null;
	setCurrentMetrics: (metrics: Record<string, number> | null) => void;

	historicalMetrics: MetricEvent[];
	addMetricEvent: (event: MetricEvent) => void;

	finalReport: RunReport | null;
	setFinalReport: (report: RunReport | null) => void;

	startTime: number | null;
	setStartTime: (time: number | null) => void;

	duration: number | null; // seconds
	setDuration: (duration: number | null) => void;
}

/**
 * Collections state
 */
export interface CollectionsState {
	collections: Collection[];
	setCollections: (collections: Collection[]) => void;

	collectionRequests: Map<string, Request[]>;
	setCollectionRequests: (collectionId: string, requests: Request[]) => void;

	loadCollections: () => Promise<void>;
	loadRequestsForCollection: (collectionId: string) => Promise<void>;
	createCollection: (name: string, parentId: string | null) => Promise<void>;
	deleteCollection: (id: string) => Promise<void>;
}

/**
 * Environments state
 */
export interface EnvironmentsState {
	environments: Environment[];
	setEnvironments: (environments: Environment[]) => void;

	activeEnvironmentId: string | null;
	setActiveEnvironmentId: (id: string | null) => void;

	loadEnvironments: () => Promise<void>;
	saveEnvironment: (env: Environment) => Promise<void>;
	deleteEnvironment: (id: string) => Promise<void>;
}

/**
 * Engine state
 */
export interface EngineState {
	config: EngineConfig | null;
	setConfig: (config: EngineConfig | null) => void;

	isConnected: boolean;
	setIsConnected: (connected: boolean) => void;

	engineVersion: string | null;
	setEngineVersion: (version: string | null) => void;

	loadConfig: () => Promise<void>;
	checkHealth: () => Promise<boolean>;
}
```

---

## 📊 Data Flow Diagram

```
User Action
  ↓
Component Event Handler
  ↓
Zustand Store Update
  ↓
Backend API Call (if needed)
  ↓
Response Handler
  ↓
Store Updated with Data
  ↓
Component Re-renders
  ↓
UI Updated
```

---

## 🔄 Example: Execute Request Flow

```typescript
// 1. User clicks [Send Request]
const handleSendRequest = async () => {
	// 2. Validate
	if (!currentRequest.url) {
		showError("URL is required");
		return;
	}

	// 3. Update UI state
	setIsSendingRequest(true);

	// 4. Build payload
	const payload: ExecuteRequestPayload = {
		method: currentRequest.method,
		url: currentRequest.url,
		headers: currentRequest.headers,
		body: currentRequest.body,
		environmentId: activeEnvironmentId,
		postRequestScript: currentRequest.postRequestScript,
	};

	try {
		// 5. API call
		const response = await fetch("/request", {
			method: "POST",
			body: JSON.stringify(payload),
		});

		const data: HttpResponse = await response.json();

		// 6. Update store
		setResponseData(data);

		// 7. Component re-renders with new response
	} catch (error) {
		showError(error.message);
	} finally {
		setIsSendingRequest(false);
	}
};
```

All data is typed and flows through Zustand stores, ensuring type safety throughout the app.
