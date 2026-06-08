/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// SSE Client - Server-Sent Events for real-time load test metrics

import { API_ENDPOINTS } from "@/config/api-endpoints";
import type { LoadTestMetrics } from "@/types";

/** Raw camelCase metrics blob as emitted by the engine SSE stream. */
interface RawSseMetrics {
	timestamp?: number;
	elapsedSeconds?: number;
	totalRequests?: number;
	totalErrors?: number;
	currentRps?: number;
	activeConnections?: number;
	latencyP50Ms?: number;
	latencyP95Ms?: number;
	latencyP99Ms?: number;
	avgLatencyMs?: number;
	sendRate?: number;
	throughput?: number;
	backpressure?: number;
	droppedRequests?: number;
	avgQueueWaitMs?: number;
	requestsSent?: number;
	requestsExpected?: number;
	bytesSent?: number;
	bytesReceived?: number;
	statusCodes?: Record<string, number>;
}

/** Map the engine's camelCase SSE blob to the frontend LoadTestMetrics shape. */
export function mapSseMetrics(m: RawSseMetrics): LoadTestMetrics {
	return {
		timestamp: m.timestamp || Date.now(),
		elapsed_seconds: m.elapsedSeconds || 0,
		requests_completed: m.totalRequests || 0,
		requests_failed: m.totalErrors || 0,
		current_rps: m.currentRps || 0,
		current_concurrency: m.activeConnections || 0,
		latency_p50_ms: m.latencyP50Ms || 0,
		latency_p95_ms: m.latencyP95Ms || 0,
		latency_p99_ms: m.latencyP99Ms || 0,
		avg_latency_ms: m.avgLatencyMs || 0,
		bytes_sent: m.bytesSent || 0,
		bytes_received: m.bytesReceived || 0,
		// Rate metrics (Open Model)
		send_rate: m.sendRate || 0,
		throughput: m.throughput || 0,
		backpressure: m.backpressure || 0,
		dropped_requests: m.droppedRequests || 0,
		avg_queue_wait_ms: m.avgQueueWaitMs || 0,
		requests_sent: m.requestsSent || 0,
		requests_expected: m.requestsExpected || 0,
		status_codes: m.statusCodes,
	};
}

export type SSEMessageHandler = (metrics: LoadTestMetrics) => void;
export type SSEErrorHandler = (error: Error) => void;
export type SSECloseHandler = () => void;

export class SSEClient {
	private eventSource: EventSource | null = null;

	// Current metrics state (reset on each connect)
	private currentMetrics: LoadTestMetrics = this.createEmptyMetrics();
	private startTime: number = 0;

	private createEmptyMetrics(): LoadTestMetrics {
		return {
			timestamp: Date.now(),
			elapsed_seconds: 0,
			requests_completed: 0,
			requests_failed: 0,
			current_rps: 0,
			current_concurrency: 0,
			latency_p50_ms: 0,
			latency_p95_ms: 0,
			latency_p99_ms: 0,
			avg_latency_ms: 0,
			bytes_sent: 0,
			bytes_received: 0,
			send_rate: 0,
			throughput: 0,
			backpressure: 0,
			dropped_requests: 0,
			avg_queue_wait_ms: 0,
			requests_sent: 0,
			requests_expected: 0,
		};
	}

	connect(
		runId: string,
		onMessage: SSEMessageHandler,
		onError: SSEErrorHandler,
		onClose: SSECloseHandler
	): void {
		// Close existing connection
		this.disconnect();

		// Reset metrics state for new connection
		this.currentMetrics = this.createEmptyMetrics();
		this.startTime = 0;

		const endpoint = API_ENDPOINTS.METRICS_LIVE(runId);
		const url = `${API_ENDPOINTS.BASE_URL}${endpoint}`;
		console.log("Connecting to live endpoint:", url);

		try {
			this.eventSource = new EventSource(url);

			// Handle metrics event - unified format from both endpoints
			this.eventSource.addEventListener("metrics", (event) => {
				try {
					// Both endpoints now send complete metrics object in same format
					const metrics = JSON.parse(event.data);

					// Initialize start time on first metrics
					if (this.startTime === 0 && metrics.timestamp) {
						this.startTime = metrics.timestamp;
					}

					// Map from backend camelCase format to frontend LoadTestMetrics
					this.currentMetrics = mapSseMetrics(metrics);

					onMessage({ ...this.currentMetrics });
				} catch (error) {
					console.error("Failed to parse metrics:", error);
				}
			});

			this.eventSource.addEventListener("complete", () => {
				console.log("Load test completed");
				// Send final metrics before closing
				onMessage({ ...this.currentMetrics });
				this.disconnect();
				onClose();
			});

			this.eventSource.addEventListener("error", (_event) => {
				// If the connection is definitively closed, treat as terminal.
				// The engine now sends an explicit `complete` event for normal run end,
				// so a CLOSED error state means a genuine connection failure.
				//
				// NOTE: we intentionally do NOT reconnect here. Standard `EventSource`
				// has no API to set the `Last-Event-ID` header on a fresh connection,
				// so a manual reconnect would request `from=0` and the engine would
				// replay the entire retained topic — duplicating every tick already
				// shown and clobbering live RPS / throughput visuals. The browser's
				// own intra-connection retry (while in CONNECTING) does carry
				// Last-Event-ID and is fine; once the browser gives up (CLOSED), the
				// canonical recovery is to converge on `GET /run/:id/report`, which
				// the load-test service does in its onClose handler.
				if (this.eventSource?.readyState === EventSource.CLOSED) {
					console.log("SSE connection closed unexpectedly — treating as terminal");
					this.disconnect();
					onClose();
				}
				// For CONNECTING state errors, wait — the browser will retry.
			});

			this.eventSource.addEventListener("open", () => {
				console.log("SSE connection established");
			});
		} catch (error) {
			onError(error instanceof Error ? error : new Error("Failed to connect to SSE"));
		}
	}

	disconnect(): void {
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
	}

	isConnected(): boolean {
		return this.eventSource?.readyState === EventSource.OPEN;
	}
}

// Export singleton instance
export const sseClient = new SSEClient();
