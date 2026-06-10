/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestService - Global singleton for managing active load test connections
 *
 * This service runs independently of React components, ensuring the SSE connection
 * stays alive regardless of navigation. Metrics are pushed to the Zustand store
 * where any component can read them.
 */

import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";
// Engine emits at 10 Hz (100ms cadence — see engine/src/http/routes/metrics.cpp).
// We throttle UI commits to keep render cost bounded, but BUFFER every tick the
// engine sends so historicalMetrics keeps the full 10 Hz signal.
import { METRICS_UI_THROTTLE_MS } from "@/config/metrics";

class LoadTestService {
	private activeRunId: string | null = null;
	private isConnected: boolean = false;
	private lastMetricsPushTime = 0;
	private pendingBuffer: LoadTestMetrics[] = [];
	private throttleTimer: ReturnType<typeof setTimeout> | null = null;

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
		// NOTE: do NOT call store.reset() here — the caller invokes store.startRun()
		// first to register the run (currentRunId, config, "running" mode) and that
		// already clears the historical series / currentMetrics / finalReport.
		// reset() would null out currentRunId and the dashboard would show no active
		// test (replay-from-0 renders clean off startRun's wipe already).
		store.setStreaming(true);
		store.setError(null);

		// Connect immediately. The engine retains a replayable tick topic per run
		// (N1), so even a sub-second run that finishes before we attach is fully
		// replayed from offset 0 — no need to delay and risk missing it.
		sseClient.connect(
			runId,
			this.handleMetrics.bind(this),
			this.handleError.bind(this),
			this.handleClose.bind(this)
		);
	}

	/**
	 * Stop monitoring the current load test
	 * Call this when the test is stopped by user or completes
	 */
	stopMonitoring(): void {
		if (!this.activeRunId) {
			return;
		}

		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = null;
		}
		this.pendingBuffer = [];
		this.lastMetricsPushTime = 0;
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
		this.pendingBuffer.push(metrics);
		const now = Date.now();
		const elapsed = now - this.lastMetricsPushTime;
		if (elapsed >= METRICS_UI_THROTTLE_MS || this.lastMetricsPushTime === 0) {
			this.flushMetrics();
		} else if (!this.throttleTimer) {
			this.throttleTimer = setTimeout(() => {
				this.throttleTimer = null;
				this.flushMetrics();
			}, METRICS_UI_THROTTLE_MS - elapsed);
		}
	}

	private flushMetrics(): void {
		if (this.pendingBuffer.length === 0) return;
		this.lastMetricsPushTime = Date.now();
		const batch = this.pendingBuffer;
		this.pendingBuffer = [];
		const store = useDashboardStore.getState();
		store.addMetricsBatch(batch);
	}

	private handleError(error: Error): void {
		console.error("[LoadTestService] SSE error:", error);
		const store = useDashboardStore.getState();
		store.setError(error.message);
	}

	private async handleClose(): Promise<void> {
		console.log("[LoadTestService] SSE closed — converging on stored report");
		const runId = this.activeRunId;
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = null;
		}
		this.flushMetrics();
		this.isConnected = false;
		const store = useDashboardStore.getState();
		store.setStreaming(false);

		// Fetch the canonical final report from the engine and store it so the
		// dashboard shows definitive completed-view data (final percentiles, reconciled
		// error rate, setup overhead) — one terminal truth, same as the 404-path.
		if (runId) {
			try {
				const report = await apiService.getRunReport(runId);
				store.setFinalReport(report);
			} catch (e) {
				console.warn("[LoadTestService] report fetch failed", e);
			}
			this.activeRunId = null;
		}
	}
}

// Export singleton instance
export const loadTestService = new LoadTestService();
