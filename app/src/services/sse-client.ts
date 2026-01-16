// SSE Client - Server-Sent Events for real-time load test metrics

import { API_ENDPOINTS } from "@/config/api-endpoints";
import type { LoadTestMetrics } from "@/types";

export type SSEMessageHandler = (metrics: LoadTestMetrics) => void;
export type SSEErrorHandler = (error: Error) => void;
export type SSECloseHandler = () => void;

export class SSEClient {
	private eventSource: EventSource | null = null;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 5;
	private reconnectDelay = 1000; // Start with 1 second
	private useLiveEndpoint = true; // Try new endpoint first
	private hasTriedFallback = false; // Track if we've tried fallback

	// Current metrics state
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

		// Try new live endpoint first, fallback to old stats endpoint
		const endpoint =
			this.useLiveEndpoint && !this.hasTriedFallback
				? API_ENDPOINTS.METRICS_LIVE(runId)
				: API_ENDPOINTS.STATS_STREAM(runId);

		const url = `${API_ENDPOINTS.BASE_URL}${endpoint}`;

		const endpointType = this.useLiveEndpoint && !this.hasTriedFallback ? "live" : "stats";
		console.log(`Connecting to ${endpointType} endpoint:`, url);

		try {
			this.eventSource = new EventSource(url);

			// Handle metrics event - unified format from both endpoints
			this.eventSource.addEventListener("metrics", (event) => {
				try {
					// Both endpoints now send complete metrics object in same format
					const metrics = JSON.parse(event.data);
					console.log("Metrics received:", metrics);

					// Initialize start time on first metrics
					if (this.startTime === 0 && metrics.timestamp) {
						this.startTime = metrics.timestamp;
					}

					// Map from backend camelCase format to frontend LoadTestMetrics
					this.currentMetrics = {
						timestamp: metrics.timestamp || Date.now(),
						elapsed_seconds: metrics.elapsedSeconds || 0,
						requests_completed: metrics.totalRequests || 0,
						requests_failed: metrics.totalErrors || 0,
						current_rps: metrics.currentRps || 0,
						current_concurrency: metrics.activeConnections || 0,
						latency_p50_ms: 0, // Not included in real-time metrics
						latency_p95_ms: 0,
						latency_p99_ms: 0,
						avg_latency_ms: metrics.avgLatencyMs || 0,
						bytes_sent: 0,
						bytes_received: 0,
					};

					onMessage({ ...this.currentMetrics });
					this.reconnectAttempts = 0;
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
				// Check if this is a 404 (endpoint not found) and we haven't tried fallback
				if (
					this.useLiveEndpoint &&
					!this.hasTriedFallback &&
					this.eventSource?.readyState === EventSource.CLOSED
				) {
					console.log("Live endpoint not available, falling back to stats endpoint...");
					this.hasTriedFallback = true;
					this.useLiveEndpoint = false;
					// Retry with old endpoint
					this.disconnect();
					setTimeout(() => {
						this.connect(runId, onMessage, onError, onClose);
					}, 100);
					return;
				}

				// SSE connections can have transient errors - only log, don't spam user
				// Check if connection is closed (real disconnect)
				if (this.eventSource?.readyState === EventSource.CLOSED) {
					console.log("SSE connection closed, attempting reconnect...");
					this.handleReconnect(runId, onMessage, onError, onClose);
				}
				// For CONNECTING state errors, just wait - the connection may recover
				// Don't call onError for transient issues
			});

			this.eventSource.addEventListener("open", () => {
				console.log("SSE connection established");
				this.reconnectAttempts = 0;
			});
		} catch (error) {
			onError(error instanceof Error ? error : new Error("Failed to connect to SSE"));
		}
	}

	private handleReconnect(
		runId: string,
		onMessage: SSEMessageHandler,
		onError: SSEErrorHandler,
		onClose: SSECloseHandler
	): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			onError(new Error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`));
			onClose();
			return;
		}

		this.reconnectAttempts++;
		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

		console.log(
			`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
		);

		setTimeout(() => {
			this.connect(runId, onMessage, onError, onClose);
		}, delay);
	}

	disconnect(): void {
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
			this.reconnectAttempts = 0;
			this.hasTriedFallback = false; // Reset for next connection
		}
	}

	isConnected(): boolean {
		return this.eventSource?.readyState === EventSource.OPEN;
	}
}

// Export singleton instance
export const sseClient = new SSEClient();
