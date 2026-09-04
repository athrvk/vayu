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
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { QUERY_CACHE } from "@/config/cache";
import { useDashboardStore } from "@/stores";
import { wakeLock, WAKE_LOCK_KEYS } from "./wake-lock";
import type { LoadTestMetrics, MonitorSample } from "@/types";
// Engine emits at 10 Hz (100ms cadence - see engine/src/http/routes/metrics.cpp).
// The batcher throttles UI commits to keep render cost bounded, but every tick
// the engine sends is BUFFERED, so historicalMetrics keeps the full 10 Hz signal.
import { createThrottledBatcher } from "./throttled-batcher";

class LoadTestService {
	private activeRunId: string | null = null;
	private isConnected: boolean = false;
	/** Ticks, buffered and committed on the live-refresh cadence. */
	private metricsBatcher = createThrottledBatcher<LoadTestMetrics>((batch) =>
		this.commitBatch(batch)
	);
	// Scrapes ride the same throttle as the ticks: they arrive on the same
	// stream and are drawn on the same chart row, so committing them separately
	// would render the overlay a frame out of step with the series under it.
	// They stay this service's own buffer - the batcher carries one list, and
	// which lists ride a flush together is a caller's decision.
	private pendingMonitor: MonitorSample[] = [];

	/**
	 * Start monitoring a load test run
	 * This connects to the SSE stream and pushes metrics to the store
	 */
	startMonitoring(runId: string): void {
		// If already monitoring this run, do nothing
		if (this.activeRunId === runId && this.isConnected) {
			return;
		}

		// If monitoring a different run, stop it first
		if (this.activeRunId && this.activeRunId !== runId) {
			this.stopMonitoring();
		}

		// Fire-and-forget: the stream below connects the same tick regardless of
		// whether the main process has answered yet.
		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "Load test run streaming");

		this.activeRunId = runId;
		this.isConnected = true;

		const store = useDashboardStore.getState();
		// Nothing here may clear the run: the caller invokes store.startRun() first
		// to register it (currentRunId, config, "running" mode) and that already
		// wipes the historical series / currentMetrics / finalReport. Nulling
		// currentRunId would leave the dashboard showing no active test while one
		// streams (replay-from-0 renders clean off startRun's wipe already). The
		// store-wide `reset` this used to warn against no longer exists.
		store.setStreaming(true);
		store.setError(null);

		// Connect immediately. The engine retains a replayable tick topic per run
		// (N1), so even a sub-second run that finishes before we attach is fully
		// replayed from offset 0 - no need to delay and risk missing it.
		sseClient.connect(
			runId,
			this.handleMetrics.bind(this),
			this.handleError.bind(this),
			this.handleClose.bind(this),
			undefined,
			this.handleMonitorSample.bind(this)
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

		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		this.metricsBatcher.discard();
		this.pendingMonitor = [];
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
		this.metricsBatcher.push(metrics);
	}

	private handleMonitorSample(sample: MonitorSample): void {
		this.pendingMonitor.push(sample);
		// No timer of its own: the next metrics flush carries it. A run always
		// ticks at least as often as the slowest scrape interval, so a sample
		// waits one tick at most - and the final flush in handleClose drains
		// whatever the last tick left behind.
	}

	/** Commit a batch of ticks together with whatever scrapes arrived beside it. */
	private commitBatch(batch: LoadTestMetrics[]): void {
		const monitor = this.pendingMonitor;
		this.pendingMonitor = [];
		const store = useDashboardStore.getState();
		store.addMetricsBatch(batch);
		store.addMonitorSamples(monitor);
	}

	/**
	 * Commit everything buffered, on either list.
	 *
	 * A scrape can outlive the last tick it would have ridden - the run ends
	 * between ticks - and the batcher commits nothing for an empty buffer, so
	 * that case commits the scrapes beside an empty tick batch, which is what
	 * this did before the batcher was extracted.
	 */
	private flushPending(): void {
		this.metricsBatcher.flush();
		if (this.pendingMonitor.length > 0) this.commitBatch([]);
	}

	private handleError(error: Error): void {
		console.error("[LoadTestService] SSE error:", error);
		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		const store = useDashboardStore.getState();
		store.setError(error.message);
	}

	private async handleClose(): Promise<void> {
		const runId = this.activeRunId;
		this.flushPending();
		this.isConnected = false;
		// Before the awaited report fetch below: the run is over the moment the
		// stream closed, and the machine must not stay pinned awake through a
		// slow fetch.
		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		const store = useDashboardStore.getState();
		store.setStreaming(false);

		// Fetch the canonical final report from the engine and store it so the
		// dashboard shows definitive completed-view data (final percentiles, reconciled
		// error rate, setup overhead) - one terminal truth, same as the 404-path.
		//
		// Through the query cache, not a bare fetch: opening the same run in
		// History reads `runs.report(runId)` and would otherwise re-fetch a
		// report that cannot change.
		if (runId) {
			try {
				const report = await queryClient.fetchQuery({
					queryKey: queryKeys.runs.report(runId),
					queryFn: () => apiService.getRunReport(runId),
					staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
				});
				// Re-read the store *after* the await. Finishing run A and
				// immediately starting run B leaves this continuation holding A's
				// report while the dashboard shows B; applying it flipped B to
				// "completed" with A's percentiles. The window is one local round
				// trip, which is exactly long enough.
				if (useDashboardStore.getState().currentRunId === runId) {
					useDashboardStore.getState().setFinalReport(report);
				}
			} catch (e) {
				console.warn("[LoadTestService] report fetch failed", e);
			}
			// The run has reached a terminal state, so the lists that carry its
			// status are stale until the next 5s poll - and once the user has
			// paged History, that poll is off.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
			this.activeRunId = null;
		}
	}
}

// Export singleton instance
export const loadTestService = new LoadTestService();
