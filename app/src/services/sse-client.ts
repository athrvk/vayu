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

	connect(
		runId: string,
		onMessage: SSEMessageHandler,
		onError: SSEErrorHandler,
		onClose: SSECloseHandler
	): void {
		// Close existing connection
		this.disconnect();

		const url = API_ENDPOINTS.STATS_STREAM(runId);

		try {
			this.eventSource = new EventSource(url);

			this.eventSource.addEventListener("metric", (event) => {
				try {
					const metrics = JSON.parse(event.data) as LoadTestMetrics;
					onMessage(metrics);
					this.reconnectAttempts = 0; // Reset on successful message
				} catch (error) {
					console.error("Failed to parse SSE metric:", error);
					onError(new Error("Failed to parse metrics data"));
				}
			});

			this.eventSource.addEventListener("complete", () => {
				console.log("Load test completed");
				this.disconnect();
				onClose();
			});

			this.eventSource.addEventListener("error", (event) => {
				console.error("SSE connection error:", event);

				// Check if connection is closed
				if (this.eventSource?.readyState === EventSource.CLOSED) {
					this.handleReconnect(runId, onMessage, onError, onClose);
				} else {
					onError(new Error("SSE connection error"));
				}
			});

			this.eventSource.addEventListener("open", () => {
				console.log("SSE connection established");
				this.reconnectAttempts = 0;
			});
		} catch (error) {
			onError(
				error instanceof Error ? error : new Error("Failed to connect to SSE")
			);
		}
	}

	private handleReconnect(
		runId: string,
		onMessage: SSEMessageHandler,
		onError: SSEErrorHandler,
		onClose: SSECloseHandler
	): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			onError(
				new Error(
					`Failed to reconnect after ${this.maxReconnectAttempts} attempts`
				)
			);
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
		}
	}

	isConnected(): boolean {
		return this.eventSource?.readyState === EventSource.OPEN;
	}
}

// Export singleton instance
export const sseClient = new SSEClient();
