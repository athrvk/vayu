# Frontend-Backend Integration Plan

**Version:** 1.0  
**Last Updated:** January 3, 2026  
**Scope:** Phase 1 Integration

---

## 📡 API Communication Strategy

### **Base URL**

```
http://127.0.0.1:9876
```

### **HTTP Client Setup**

Create `src/lib/httpClient.ts`:

```typescript
export const apiClient = {
	baseURL: "http://127.0.0.1:9876",

	async request<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		body?: any,
		options?: { timeout?: number }
	): Promise<T> {
		const controller = new AbortController();
		const timeout = options?.timeout || 30000;

		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(`${this.baseURL}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			return await response.json();
		} finally {
			clearTimeout(timeoutId);
		}
	},

	// Convenience methods
	get<T>(path: string) {
		return this.request<T>("GET", path);
	},
	post<T>(path: string, body: any) {
		return this.request<T>("POST", path, body);
	},
	put<T>(path: string, body: any) {
		return this.request<T>("PUT", path, body);
	},
	delete<T>(path: string) {
		return this.request<T>("DELETE", path);
	},
};
```

---

## 🔌 Custom Hooks for Backend Communication

### **1. useHealth() - Check Engine Status**

```typescript
// hooks/useHealth.ts
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/httpClient";

export function useHealth() {
	const [isHealthy, setIsHealthy] = useState(false);
	const [version, setVersion] = useState<string | null>(null);
	const [workers, setWorkers] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const checkHealth = async () => {
			try {
				const data = await apiClient.get<{
					status: string;
					version: string;
					workers: number;
				}>("/health");

				if (data.status === "ok") {
					setIsHealthy(true);
					setVersion(data.version);
					setWorkers(data.workers);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				setIsHealthy(false);
			} finally {
				setLoading(false);
			}
		};

		checkHealth();

		// Ping every 5 seconds
		const interval = setInterval(checkHealth, 5000);
		return () => clearInterval(interval);
	}, []);

	return { isHealthy, version, workers, loading, error };
}
```

### **2. useCollections() - Load Collections Tree**

```typescript
// hooks/useCollections.ts
import { useEffect } from "react";
import { useCollectionsStore } from "@/stores/collectionsStore";
import { apiClient } from "@/lib/httpClient";

export function useCollections() {
	const {
		collections,
		loadCollections: loadFromStore,
		setCollections,
	} = useCollectionsStore();

	useEffect(() => {
		const fetchCollections = async () => {
			try {
				const data = await apiClient.get<Collection[]>("/collections");
				setCollections(data);
			} catch (error) {
				console.error("Failed to load collections:", error);
			}
		};

		fetchCollections();
	}, [setCollections]);

	return {
		collections,
		reload: loadFromStore,
	};
}
```

### **3. useEngine() - Execute Requests**

```typescript
// hooks/useEngine.ts
import { useState } from "react";
import { apiClient } from "@/lib/httpClient";
import { ExecuteRequestPayload, HttpResponse } from "@/types";

export function useEngine() {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const executeRequest = async (
		payload: ExecuteRequestPayload
	): Promise<HttpResponse | null> => {
		setLoading(true);
		setError(null);

		try {
			const response = await apiClient.post<HttpResponse>("/request", payload);
			return response;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Request failed";
			setError(message);
			return null;
		} finally {
			setLoading(false);
		}
	};

	const startLoadTest = async (
		payload: StartLoadTestPayload
	): Promise<string | null> => {
		setLoading(true);
		setError(null);

		try {
			const response = await apiClient.post<StartLoadTestResponse>(
				"/run",
				payload
			);
			return response.runId;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Load test failed";
			setError(message);
			return null;
		} finally {
			setLoading(false);
		}
	};

	const stopTest = async (runId: string): Promise<boolean> => {
		try {
			await apiClient.post(`/run/${runId}/stop`, {});
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Stop failed");
			return false;
		}
	};

	return {
		executeRequest,
		startLoadTest,
		stopTest,
		loading,
		error,
	};
}
```

### **4. useSSE() - Stream Real-time Metrics**

```typescript
// hooks/useSSE.ts
import { useEffect, useState, useCallback } from "react";

interface SSEOptions {
	onMetric?: (metric: MetricEvent) => void;
	onComplete?: () => void;
	onError?: (error: string) => void;
}

export function useSSE(runId: string, options: SSEOptions = {}) {
	const [isConnected, setIsConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!runId) return;

		const eventSource = new EventSource(`http://127.0.0.1:9876/stats/${runId}`);

		setIsConnected(true);
		setError(null);

		eventSource.addEventListener("metric", (event) => {
			try {
				const metric = JSON.parse(event.data) as MetricEvent;
				options.onMetric?.(metric);
			} catch (err) {
				console.error("Failed to parse metric:", err);
			}
		});

		eventSource.addEventListener("complete", () => {
			setIsConnected(false);
			options.onComplete?.();
			eventSource.close();
		});

		eventSource.addEventListener("error", (event) => {
			const message = "SSE connection error";
			setError(message);
			options.onError?.(message);
			eventSource.close();
		});

		return () => {
			eventSource.close();
			setIsConnected(false);
		};
	}, [runId, options]);

	return { isConnected, error };
}
```

### **5. useRunReport() - Fetch Final Results**

```typescript
// hooks/useRunReport.ts
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/httpClient";
import { RunReport } from "@/types";

export function useRunReport(runId: string | null) {
	const [report, setReport] = useState<RunReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!runId) return;

		const fetchReport = async () => {
			setLoading(true);
			setError(null);

			try {
				const data = await apiClient.get<RunReport>(`/run/${runId}/report`);
				setReport(data);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to fetch report");
			} finally {
				setLoading(false);
			}
		};

		// Delay to allow backend to finalize report
		const timeout = setTimeout(fetchReport, 1000);
		return () => clearTimeout(timeout);
	}, [runId]);

	return { report, loading, error };
}
```

### **6. useRuns() - Load Run History**

```typescript
// hooks/useRuns.ts
import { useEffect } from "react";
import { useHistoryStore } from "@/stores/historyStore";
import { apiClient } from "@/lib/httpClient";
import { Run } from "@/types";

export function useRuns() {
	const { runs, setRuns, loading, error } = useHistoryStore();

	const reload = async () => {
		try {
			const data = await apiClient.get<Run[]>("/runs");
			setRuns(data);
		} catch (err) {
			console.error("Failed to load runs:", err);
		}
	};

	useEffect(() => {
		reload();
	}, []);

	return {
		runs,
		loading,
		error,
		reload,
	};
}
```

---

## 📝 Zustand Store Architecture

### **Collections Store**

```typescript
// stores/collectionsStore.ts
import { create } from "zustand";
import { Collection, Request } from "@/types";

interface CollectionsStore {
	collections: Collection[];
	requestsByCollectionId: Map<string, Request[]>;
	selectedCollectionId: string | null;

	setCollections: (collections: Collection[]) => void;
	setRequestsForCollection: (collectionId: string, requests: Request[]) => void;
	setSelectedCollectionId: (id: string | null) => void;
	loadCollections: () => Promise<void>;
}

export const useCollectionsStore = create<CollectionsStore>((set) => ({
	collections: [],
	requestsByCollectionId: new Map(),
	selectedCollectionId: null,

	setCollections: (collections) => set({ collections }),
	setRequestsForCollection: (collectionId, requests) =>
		set((state) => ({
			requestsByCollectionId: new Map(state.requestsByCollectionId).set(
				collectionId,
				requests
			),
		})),
	setSelectedCollectionId: (id) => set({ selectedCollectionId: id }),

	loadCollections: async () => {
		try {
			const collections = await apiClient.get<Collection[]>("/collections");
			set({ collections });
		} catch (error) {
			console.error("Failed to load collections:", error);
		}
	},
}));
```

### **Request Builder Store**

```typescript
// stores/requestStore.ts
import { create } from "zustand";
import { Request, HttpResponse } from "@/types";

interface RequestStore {
	currentRequest: Request | null;
	responseData: HttpResponse | null;
	unsavedChanges: boolean;
	isSending: boolean;

	setCurrentRequest: (request: Request | null) => void;
	updateRequest: (updates: Partial<Request>) => void;
	setResponseData: (response: HttpResponse | null) => void;
	setUnsavedChanges: (changed: boolean) => void;
	setIsSending: (sending: boolean) => void;
}

export const useRequestStore = create<RequestStore>((set) => ({
	currentRequest: null,
	responseData: null,
	unsavedChanges: false,
	isSending: false,

	setCurrentRequest: (request) => set({ currentRequest: request }),
	updateRequest: (updates) =>
		set((state) => ({
			currentRequest: state.currentRequest
				? { ...state.currentRequest, ...updates }
				: null,
			unsavedChanges: true,
		})),
	setResponseData: (response) => set({ responseData: response }),
	setUnsavedChanges: (changed) => set({ unsavedChanges: changed }),
	setIsSending: (sending) => set({ isSending: sending }),
}));
```

### **Dashboard Store**

```typescript
// stores/dashboardStore.ts
import { create } from "zustand";
import { MetricEvent, RunReport } from "@/types";

interface DashboardStore {
	metrics: Map<string, number>;
	historicalMetrics: MetricEvent[];
	finalReport: RunReport | null;
	startTime: number | null;
	duration: number | null; // seconds

	addMetric: (metric: MetricEvent) => void;
	setFinalReport: (report: RunReport | null) => void;
	setDuration: (duration: number) => void;
	reset: () => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
	metrics: new Map(),
	historicalMetrics: [],
	finalReport: null,
	startTime: Date.now(),
	duration: null,

	addMetric: (metric) =>
		set((state) => {
			const newMetrics = new Map(state.metrics);
			newMetrics.set(metric.name, metric.value);
			return {
				metrics: newMetrics,
				historicalMetrics: [...state.historicalMetrics, metric],
			};
		}),
	setFinalReport: (report) => set({ finalReport: report }),
	setDuration: (duration) => set({ duration }),
	reset: () => ({
		metrics: new Map(),
		historicalMetrics: [],
		finalReport: null,
		startTime: Date.now(),
		duration: null,
	}),
}));
```

---

## 🔄 Error Handling Strategy

### **API Error Handling**

```typescript
// lib/errorHandler.ts
export class ApiError extends Error {
	constructor(
		public statusCode: number,
		public errorCode: string,
		message: string
	) {
		super(message);
		this.name = "ApiError";
	}
}

export async function handleApiError(response: Response): Promise<never> {
	const data = await response.json();
	throw new ApiError(
		response.status,
		data.error?.code || "UNKNOWN_ERROR",
		data.error?.message || `HTTP ${response.status}`
	);
}

export function getErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "An unknown error occurred";
}
```

### **Component Error Boundaries**

```typescript
// components/ErrorBoundary.tsx
import { ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback?: (error: Error, retry: () => void) => ReactNode;
}

export function ErrorBoundary({ children, fallback }: Props) {
	// Implement error boundary for graceful error handling
}
```

---

## 🔐 Request Validation

### **Request Validation**

```typescript
// lib/validators.ts
export const validateRequest = (request: Request): string[] => {
	const errors: string[] = [];

	if (!request.url) errors.push("URL is required");
	if (!request.method) errors.push("Method is required");
	if (request.url && !isValidUrl(request.url)) {
		errors.push("Invalid URL format");
	}

	return errors;
};

function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}
```

---

## ⏱️ Auto-Save Implementation

### **Auto-Save Hook**

```typescript
// hooks/useAutoSave.ts
import { useEffect, useRef } from "react";
import { Request } from "@/types";
import { apiClient } from "@/lib/httpClient";

export function useAutoSave(
	request: Request | null,
	onSave?: () => void,
	debounceMs: number = 5000
) {
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		if (!request) return;

		// Clear existing timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Set new timeout for auto-save
		timeoutRef.current = setTimeout(async () => {
			try {
				await apiClient.post("/requests", request);
				onSave?.();
			} catch (error) {
				console.error("Auto-save failed:", error);
			}
		}, debounceMs);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [request, onSave, debounceMs]);
}
```

---

## 🚀 Request/Response Lifecycle

### **Execution Flow**

```
User fills form
  ↓
updateRequest() → Zustand store
  ↓ (5 seconds idle)
  ↓
Auto-save: POST /requests
  ↓
User clicks [Send Request]
  ↓
validateRequest()
  ↓
(If errors, show validation errors)
  ↓
(If valid, save first if changes)
  ↓
POST /request
  ↓
Response received
  ↓
Store in responseData
  ↓
ResponseViewer component re-renders
```

---

## 📊 Load Test Lifecycle

### **Load Test Flow**

```
User clicks [Load Test]
  ↓
LoadTestConfigDialog opens
  ↓
User configures test (mode, duration, RPS/concurrency)
  ↓
User clicks [Start Load Test]
  ↓
Save request first (if changes)
  ↓
POST /run
  ↓
202 Accepted + runId
  ↓
Switch to LoadTestDashboard
  ↓
Open EventSource: GET /stats/:runId
  ↓
Metrics arrive every ~100ms
  ↓
Update dashboard in real-time
  ↓
User can click [Stop Test] anytime
  ↓
POST /run/:runId/stop
  ↓
Event: complete arrives
  ↓
EventSource closes
  ↓
GET /run/:runId/report
  ↓
Display final metrics
```

---

## ✅ Integration Checklist

- [ ] Setup HTTP client with proper error handling
- [ ] Create all custom hooks (useHealth, useCollections, useEngine, etc.)
- [ ] Setup Zustand stores (collections, requests, dashboard, history)
- [ ] Implement auto-save with debouncing (5 seconds)
- [ ] Setup request validation
- [ ] Setup error boundaries and error handling
- [ ] Test all API endpoints against backend
- [ ] Test SSE streaming for load test metrics
- [ ] Test error scenarios (network failures, timeouts)
- [ ] Optimize re-renders with proper memoization

---

## 🔍 Testing API Endpoints

All endpoints should be tested manually in development:

```bash
# Test health
curl http://127.0.0.1:9876/health

# Test collections
curl http://127.0.0.1:9876/collections

# Test single request
curl -X POST http://127.0.0.1:9876/request \
  -H "Content-Type: application/json" \
  -d '{"method":"GET","url":"https://httpbin.org/get"}'

# Test load test
curl -X POST http://127.0.0.1:9876/run \
  -H "Content-Type: application/json" \
  -d '{
    "request":{"method":"GET","url":"https://httpbin.org/get"},
    "mode":"constant",
    "duration":"10s",
    "targetRps":10
  }'

# Test SSE stats
curl http://127.0.0.1:9876/stats/run_123
```

---

Ready for development phases!
