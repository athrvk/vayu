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

import { sseClient, type SSETerminalStatus } from "./sse-client";
import { apiService } from "./api";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { QUERY_CACHE } from "@/config/cache";
import { useDashboardStore, useClientSettingsStore, deriveRunProgress } from "@/stores";
import { wakeLock, WAKE_LOCK_KEYS } from "./wake-lock";
import { runProgress, RUN_PROGRESS_KEYS } from "./run-progress";
import { systemNotify, NOTIFY_KINDS } from "./notify";
import { osIcon } from "./os-icon";
import { formatNumber } from "@/utils/helpers";
import type { LoadTestMetrics, MonitorSample, RunReport } from "@/types";
// Engine emits at 10 Hz (100ms cadence - see engine/src/http/routes/metrics.cpp).
// The batcher throttles UI commits to keep render cost bounded, but every tick
// the engine sends is BUFFERED, so historicalMetrics keeps the full 10 Hz signal.
import { createThrottledBatcher } from "./throttled-batcher";

/** The three ways a load run ends, as the user hears about them (#1358). */
type LoadRunNotifyKind =
	| typeof NOTIFY_KINDS.loadRunFinished
	| typeof NOTIFY_KINDS.loadRunStopped
	| typeof NOTIFY_KINDS.loadRunFailed;

const NOTIFY_TITLES: Record<LoadRunNotifyKind, string> = {
	[NOTIFY_KINDS.loadRunFinished]: "Load test finished",
	[NOTIFY_KINDS.loadRunStopped]: "Load test stopped",
	[NOTIFY_KINDS.loadRunFailed]: "Load test failed",
};

/**
 * "12,400 requests, p95 210 ms, 0.3% errors", or `null` when the report cannot
 * supply all three.
 *
 * The numbers, not an adjective: a notification that says only "finished"
 * makes the user open the app to learn what a glance should have told them.
 * Checked rather than trusted, because the report crosses a process boundary
 * and a partial one must not turn into "0 requests, p95 0 ms" - a number the
 * user would read as the run's own.
 */
function runSummaryLine(report: RunReport): string | null {
	const requests = report.summary?.totalRequests;
	const p95 = report.latency?.p95;
	const errorRate = report.summary?.errorRate;
	if (typeof requests !== "number" || typeof p95 !== "number" || typeof errorRate !== "number") {
		return null;
	}
	return `${formatNumber(requests)} requests, p95 ${Math.round(p95)} ms, ${errorRate.toFixed(1)}% errors`;
}

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
	 * The run this service has already told the user about (#1358).
	 *
	 * A failing run reports its error and *then* closes its stream, so both
	 * terminal paths run for one run. The user gets the first of them - the one
	 * that says what went wrong - and never a second notification saying the
	 * same run finished.
	 */
	private notifiedRunId: string | null = null;
	/**
	 * The run whose failure the OS indicator has already been told about (#1362).
	 *
	 * A failing run reports its error and *then* closes its stream, and the
	 * failed state is a two-second flash the main process clears on its own
	 * timer. Clearing again as the stream closes would wipe it in the same tick
	 * it was painted, which is the whole of what this remembers.
	 */
	private progressFailedRunId: string | null = null;

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

		// Only on the user's standing say-so (#1357). With the setting off, a run
		// long enough to be walked away from is asked about instead, and that ask
		// takes the lock itself - see `KeepAwakePrompt`. Read here rather than
		// watched, so the answer for a run is the one that was true when it
		// started. Fire-and-forget either way: the stream below connects the same
		// tick regardless of whether the main process has answered yet.
		if (useClientSettingsStore.getState().keepAwakeDuringRuns) {
			wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "Load test run streaming");
		}

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

		// The OS indicator starts the moment the run does (#1362), claimed for
		// this run rather than for load runs in general (#1405): every later call
		// names the run it speaks for, so a run this one supersedes cannot paint
		// over it. It starts without a fraction - nothing has ticked yet - and
		// the first committed batch below replaces that with a real one where the
		// run has a denominator at all.
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, runId);

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
		const runId = this.activeRunId;
		if (!runId) {
			return;
		}

		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, runId);
		this.notifyTerminal(
			runId,
			NOTIFY_KINDS.loadRunStopped,
			"The run was stopped before it finished."
		);
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

	/**
	 * Tell the user their run ended, once, and only if they are elsewhere -
	 * `electron/notify.ts` answers the "elsewhere" half.
	 */
	private notifyTerminal(runId: string | null, kind: LoadRunNotifyKind, body: string): void {
		if (!runId || this.notifiedRunId === runId) return;
		this.notifiedRunId = runId;
		systemNotify.post({
			kind,
			title: NOTIFY_TITLES[kind],
			body,
			target: { view: "run", runId },
		});
		// Here rather than beside `runProgress.fail` (#1364), deliberately:
		// `notifyTerminal` is guarded by `notifiedRunId`, so it fires exactly
		// once per run, and every terminal path reaches it - the SSE error
		// handler and a clean close alike - not only the failure one.
		if (kind === NOTIFY_KINDS.loadRunFailed) osIcon.runFailed();
		// Not for a stopped run: the user pressed Stop, so they were here and
		// already know. The service itself sends nothing when the notifications
		// this substitutes for are on (#1364).
		if (kind !== NOTIFY_KINDS.loadRunStopped) osIcon.runFinished();
	}

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

		// The taskbar and Dock ride the flush rather than the tick (#1362): this
		// is already the live-refresh cadence, so the OS repaints as often as the
		// chart does and no more. An empty batch is a scrape-only flush and says
		// nothing new about progress.
		const latest = batch[batch.length - 1];
		if (latest) {
			runProgress.report(
				RUN_PROGRESS_KEYS.loadRun,
				this.activeRunId,
				deriveRunProgress(store.loadTestConfig, latest)
			);
		}
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
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun, this.activeRunId);
		this.progressFailedRunId = this.activeRunId;
		this.notifyTerminal(this.activeRunId, NOTIFY_KINDS.loadRunFailed, error.message);
		const store = useDashboardStore.getState();
		store.setError(error.message);
	}

	/**
	 * The stream ended. `status` is what the engine's completion frame said, or
	 * null for a stream that ended without one - a dropped connection, or an
	 * older engine (issue #1415).
	 */
	private async handleClose(status: SSETerminalStatus = null): Promise<void> {
		const runId = this.activeRunId;
		this.flushPending();
		this.isConnected = false;
		// Before the awaited report fetch below: the run is over the moment the
		// stream closed, and the machine must not stay pinned awake through a
		// slow fetch.
		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		// Same reason, and the same moment: the run is over, so the taskbar stops
		// claiming one is going. A run that already reported its failure keeps
		// that flash instead - see `progressFailedRunId`. A close with no run to
		// name clears nothing: it holds no claim, and the bar it would wipe
		// belongs to whatever run is being watched now (#1405).
		if (this.progressFailedRunId !== runId) {
			runProgress.clear(RUN_PROGRESS_KEYS.loadRun, runId);
		}
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
			// Stands unless the report arrives with all three numbers in it: a run
			// that ended is worth saying even when what it did cannot be read.
			let summary: string | null = null;
			/** The stored row's own verdict, read only when the frame had none. */
			let reportStatus: string | null = null;
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
				// Last inside the try: the dashboard is the terminal surface that
				// matters, and nothing done for a notification may come before it.
				summary = runSummaryLine(report);
				reportStatus = report.metadata?.status ?? null;
			} catch (e) {
				console.warn("[LoadTestService] report fetch failed", e);
			}
			// After the fetch, so the body carries the run's own numbers. A run
			// that already reported a failure has had its one notification.
			//
			// A failed run is not a finished one, and until #1415 this said
			// finished for both: the frame's status is preferred, and the
			// report's own is the fallback for a stream that ended without one.
			// The frame first, deliberately - the fetch above can fail, and a
			// failure that could not be read must still report a failure rather
			// than quietly report success.
			const failed = status === "Failed" || (status === null && reportStatus === "Failed");
			this.notifyTerminal(
				runId,
				failed ? NOTIFY_KINDS.loadRunFailed : NOTIFY_KINDS.loadRunFinished,
				summary ?? "The run ended, but its report could not be read."
			);
			// The run has reached a terminal state, so the lists that carry its
			// status are stale until the next 5s poll - and once the user has
			// paged History, that poll is off.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
			// Only if it is still this run's. Same window as the store read above,
			// and the same fix: a run started while this fetch was in flight has
			// already put its own id here, and forgetting it would leave the
			// service unable to name the run it is watching - so the live run's
			// reports would be dropped and its bar never cleared, both of which
			// now turn on naming the run (#1405).
			if (this.activeRunId === runId) {
				this.activeRunId = null;
			}
		}
	}
}

// Export singleton instance
export const loadTestService = new LoadTestService();
