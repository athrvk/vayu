/**
 * LoadTestService - Global singleton for managing active load test connections
 * 
 * This service runs independently of React components, ensuring the SSE connection
 * stays alive regardless of navigation. Metrics are pushed to the Zustand store
 * where any component can read them.
 */

import { sseClient } from "./sse-client";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";

class LoadTestService {
	private activeRunId: string | null = null;
	private isConnected: boolean = false;

	/**
	 * Start monitoring a load test run
	 * This connects to the SSE stream and pushes metrics to the store
	 */
	startMonitoring(runId: string): void {
		// If already monitoring this run, do nothing
		if (this.activeRunId === runId && this.isConnected) {
			console.log(`[LoadTestService] Already monitoring run ${runId}`);
			return;
		}

		// If monitoring a different run, stop it first
		if (this.activeRunId && this.activeRunId !== runId) {
			console.log(`[LoadTestService] Switching from run ${this.activeRunId} to ${runId}`);
			this.stopMonitoring();
		}

		console.log(`[LoadTestService] Starting monitoring for run ${runId}`);
		this.activeRunId = runId;
		this.isConnected = true;

		const store = useDashboardStore.getState();
		store.setStreaming(true);
		store.setError(null);

		// Connect to SSE with a small delay to let backend set up
		setTimeout(() => {
			if (this.activeRunId === runId) {
				sseClient.connect(
					runId,
					this.handleMetrics.bind(this),
					this.handleError.bind(this),
					this.handleClose.bind(this)
				);
			}
		}, 500);
	}

	/**
	 * Stop monitoring the current load test
	 * Call this when the test is stopped by user or completes
	 */
	stopMonitoring(): void {
		if (!this.activeRunId) {
			return;
		}

		console.log(`[LoadTestService] Stopping monitoring for run ${this.activeRunId}`);
		this.activeRunId = null;
		this.isConnected = false;
		sseClient.disconnect();
	}

	/**
	 * Check if currently monitoring a specific run
	 */
	isMonitoring(runId?: string): boolean {
		if (runId) {
			return this.activeRunId === runId && this.isConnected;
		}
		return this.isConnected;
	}

	/**
	 * Get the currently monitored run ID
	 */
	getActiveRunId(): string | null {
		return this.activeRunId;
	}

	// --- Private handlers ---

	private handleMetrics(metrics: LoadTestMetrics): void {
		const store = useDashboardStore.getState();
		store.addMetrics(metrics);
	}

	private handleError(error: Error): void {
		console.error("[LoadTestService] SSE error:", error);
		const store = useDashboardStore.getState();
		store.setError(error.message);
	}

	private handleClose(): void {
		console.log("[LoadTestService] SSE connection closed (test completed)");
		
		const store = useDashboardStore.getState();
		store.setStreaming(false);
		
		// Clean up internal state
		// Don't call stopRun() here - that's for manual stops only
		// The dashboard will fetch the final report which sets the correct mode
		if (this.activeRunId) {
			this.activeRunId = null;
			this.isConnected = false;
		}
	}
}

// Export singleton instance
export const loadTestService = new LoadTestService();
