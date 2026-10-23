/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Dashboard State Store (Load Test Metrics)

import { create } from "zustand";
import type { LoadTestMetrics, MonitorSample, RunReport } from "@/types";
import {
	breakpointAt,
	notCrossed,
	type Breakpoint,
} from "@/modules/dashboard/utils/computeBreakpoint";
import { foldLagStreak } from "@/modules/dashboard/utils/dispatchLag";
import { foldPeakReading } from "@/modules/dashboard/utils/p99AtPeak";
import { hasSecondPercentiles } from "@/modules/dashboard/utils/tickPercentiles";
import { useClientSettingsStore } from "./client-settings-store";
import {
	DEFAULT_LIVE_WINDOW,
	liveWindowSeconds as windowSecondsFor,
	DEFAULT_MAX_RETAINED_TICKS,
} from "@/constants/live-window";
import { durationSeconds } from "@/constants/load-test";
import { isRunInProgress } from "@/lib/run-status";
import type { DashboardMode } from "@/modules/dashboard/types";

/**
 * Retention seeded before the window is known. The real value is the engine's
 * `liveReplayWindowMs`, which `useLiveWindowSync` (mounted at the App root)
 * pushes in once the config query resolves - it cannot be read synchronously
 * here the way the old localStorage preference could. Seeding the module default rather than `null`
 * keeps retention bounded during that gap; a run started in the first moments
 * after launch trims to 5 minutes until the hook corrects it.
 */
function initialLiveWindowSeconds(): number | null {
	return windowSecondsFor(DEFAULT_LIVE_WINDOW);
}

// Config passed when starting a load test (for display during streaming)
export interface LoadTestRunConfig {
	mode?: string;
	duration?: string;
	targetRps?: number;
	concurrency?: number;
	iterations?: number;
	comment?: string;
	rampUpDuration?: string;
	startConcurrency?: number;
	/** How many `data` rows the run was started with; absent without a data file. */
	dataRowCount?: number;
	/** The data file's name and content hash (issue #2051); absent without one. */
	dataFileName?: string;
	dataFileHash?: string;
	/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
	dataFileCastNumbers?: boolean;
}

/**
 * The mode a finished run settles in. A stop the user asked for stays "stopped"
 * whatever the report says; otherwise the engine's own status decides, so a
 * failed run is not shown as a neutral "completed" (#1932).
 */
function finalModeFor(current: DashboardMode, reportStatus: string | undefined): DashboardMode {
	if (current === "stopped" || reportStatus === "stopped") return "stopped";
	return reportStatus === "failed" ? "failed" : "completed";
}

/**
 * How far through a load run one tick is, as 0..1, or `null` when the run has
 * no denominator to be a fraction of (issue #1362).
 *
 * Two denominators, in this order, because they are not equally good. The
 * engine publishes `requestsExpected` for every mode that can know it - a rate
 * times a duration, or an iteration count (`load_strategy.cpp`) - and that is
 * the run's own arithmetic rather than the client's. A duration-bounded
 * `constant_concurrency` run publishes no such count, so elapsed-over-duration
 * is what is left; it is the same fraction the run's clock is counting down.
 *
 * Not held as state: the one reader is the taskbar and Dock indicator, and a
 * field the store recorded for nobody is the defect the repo names most often.
 */
export function deriveRunProgress(
	config: LoadTestRunConfig | null,
	tick: LoadTestMetrics | null
): number | null {
	const clamp = (value: number): number => Math.min(1, Math.max(0, value));

	const expected = tick?.requests_expected;
	const sent = tick?.requests_sent;
	if (typeof expected === "number" && expected > 0 && typeof sent === "number") {
		return clamp(sent / expected);
	}

	const total = durationSeconds(config?.duration);
	const elapsed = tick?.elapsed_seconds;
	if (total !== null && typeof elapsed === "number") return clamp(elapsed / total);

	return null;
}

// Request info passed when starting a load test
export interface LoadTestRequestInfo {
	method: string;
	url: string;
}

interface DashboardState {
	currentRunId: string | null;
	mode: DashboardMode;
	isStreaming: boolean;
	currentMetrics: LoadTestMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	/**
	 * Server vitals scraped during this run, oldest first. Kept beside the ticks
	 * rather than merged into them: the two are sampled by different clocks, and
	 * the join onto the tick timeline happens at render time
	 * ({@link joinMonitorToTimeline}) so a changing retention window cannot
	 * strand a reading on a tick that has rolled out.
	 *
	 * Empty for a run that configured no monitor, which is what the chart row
	 * reads to stay out of the way entirely.
	 */
	monitorSamples: MonitorSample[];
	finalReport: RunReport | null;
	error: string | null;
	isStopping: boolean;
	// Config and request info (available during live streaming)
	loadTestConfig: LoadTestRunConfig | null;
	requestInfo: LoadTestRequestInfo | null;
	/** Request that initiated the run, so the dashboard can navigate back to it. */
	sourceRequestId: string | null;
	/**
	 * Running monotonic aggregates updated on each tick in {@link addMetricsBatch}.
	 * Stored here instead of recomputed in MetricsView so that consumers see O(1)
	 * updates per tick rather than a full scan of {@link historicalMetrics}. Both
	 * are latched (peak only grows, breakpoint sticks on first crossing), so they
	 * survive old ticks rolling out of the retention window. See PR #26 / #25.
	 */
	peakConcurrency: number;
	breakpoint: Breakpoint;
	/**
	 * Worst whole-second p99 (ms) at {@link peakConcurrency}, reset whenever the
	 * peak rises (see `foldPeakReading`); `undefined` until a tick at the peak
	 * held a reading. Latched like the two above so retention cannot trim it.
	 */
	p99AtPeakMs: number | undefined;
	/**
	 * `elapsed_seconds` at which the windowed send rate began to outrun the
	 * windowed completion rate (see `foldLagStreak`); `null` while they agree.
	 * Latched so the Send / Throughput chip can ask "held for how long" without
	 * reading the retained buffer.
	 */
	dispatchLagSinceSeconds: number | null;
	/**
	 * Live retention window in seconds (null = full run, bounded by
	 * {@link maxRetainedTicks}). Drives the time-based trim in
	 * {@link addMetricsBatch}. Kept in sync by useLiveWindowSync.
	 */
	liveWindowSeconds: number | null;
	/**
	 * Ceiling on retained ticks whatever the window - the memory backstop, and
	 * the same `liveMaxRetainedTicks` value the engine bounds its replay ring
	 * with, so this side never discards what the engine went to the trouble of
	 * retaining. Also synced by useLiveWindowSync.
	 */
	maxRetainedTicks: number;

	// Actions
	startRun: (
		runId: string,
		config?: LoadTestRunConfig,
		requestInfo?: LoadTestRequestInfo,
		sourceRequestId?: string | null
	) => void;
	/**
	 * Fill in the config and request a run was started without (issue #1935).
	 * Touches those two fields and nothing else: the run is already streaming,
	 * and {@link startRun} would clear the metrics it has gathered.
	 */
	setRunConfig: (config: LoadTestRunConfig, requestInfo: LoadTestRequestInfo | null) => void;
	stopRun: () => void;
	setStreaming: (streaming: boolean) => void;
	setLiveWindowSeconds: (seconds: number | null) => void;
	setMaxRetainedTicks: (ticks: number) => void;
	addMetricsBatch: (batch: LoadTestMetrics[]) => void;
	addMonitorSamples: (batch: MonitorSample[]) => void;
	setFinalReport: (report: RunReport) => void;
	setError: (error: string | null) => void;
	setStopping: (stopping: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
	currentRunId: null,
	mode: "running",
	isStreaming: false,
	currentMetrics: null,
	historicalMetrics: [],
	monitorSamples: [],
	finalReport: null,
	error: null,
	isStopping: false,
	loadTestConfig: null,
	requestInfo: null,
	sourceRequestId: null,
	peakConcurrency: 0,
	breakpoint: notCrossed(null),
	p99AtPeakMs: undefined,
	dispatchLagSinceSeconds: null,
	liveWindowSeconds: initialLiveWindowSeconds(),
	maxRetainedTicks: DEFAULT_MAX_RETAINED_TICKS,

	startRun: (runId, config, requestInfo, sourceRequestId) =>
		set({
			currentRunId: runId,
			mode: "running",
			isStreaming: true,
			currentMetrics: null,
			historicalMetrics: [],
			monitorSamples: [],
			finalReport: null,
			error: null,
			isStopping: false,
			loadTestConfig: config ?? null,
			requestInfo: requestInfo ?? null,
			sourceRequestId: sourceRequestId ?? null,
			peakConcurrency: 0,
			breakpoint: notCrossed(useClientSettingsStore.getState().sloThresholdMs),
			p99AtPeakMs: undefined,
			dispatchLagSinceSeconds: null,
		}),

	setRunConfig: (config, requestInfo) =>
		set((state) => ({
			loadTestConfig: config,
			requestInfo: requestInfo ?? state.requestInfo,
		})),

	stopRun: () =>
		set({
			mode: "stopped",
			isStreaming: false,
			// A stream callout is about a run still going; this one was stopped, and
			// the report effect holds off while the callout is up (#1925).
			error: null,
		}),

	setStreaming: (streaming) => set({ isStreaming: streaming }),

	setLiveWindowSeconds: (seconds) => set({ liveWindowSeconds: seconds }),

	setMaxRetainedTicks: (ticks) =>
		set({ maxRetainedTicks: ticks > 0 ? ticks : DEFAULT_MAX_RETAINED_TICKS }),

	addMetricsBatch: (batch) =>
		set((state) => {
			if (batch.length === 0) return state;
			let newHistory = [...state.historicalMetrics, ...batch];

			// Time-based retention: drop ticks older than the configured window,
			// measured against the newest tick's elapsed time. History is
			// time-ordered ascending and trimmed every batch, so this scans only
			// the few newly-expired ticks at the front (not the whole array).
			const winS = state.liveWindowSeconds;
			if (winS != null) {
				const cutoff = newHistory[newHistory.length - 1].elapsed_seconds - winS;
				let start = 0;
				while (start < newHistory.length && newHistory[start].elapsed_seconds < cutoff) {
					start++;
				}
				if (start > 0) newHistory = newHistory.slice(start);
			}
			// Hard safety cap regardless of window (bounds memory on a very long
			// "full run" or an unexpectedly high tick rate).
			const cap = state.maxRetainedTicks;
			if (newHistory.length > cap) {
				newHistory = newHistory.slice(-cap);
			}

			// Fold the new ticks into the running aggregates: peak only grows,
			// breakpoint is latched on the first SLO crossing, the p99 at peak
			// restarts whenever the peak rises, and the lag streak restarts whenever
			// the windowed rates agree again - so we walk each batch entry exactly
			// once, never the full history.
			const sloMs = useClientSettingsStore.getState().sloThresholdMs;
			let lagSince = state.dispatchLagSinceSeconds;
			let peakReading = { peak: state.peakConcurrency, p99Ms: state.p99AtPeakMs };
			// An uncrossed breakpoint names the SLO it is being judged against, so a
			// threshold changed mid-run is followed until the first crossing latches.
			let bp =
				state.breakpoint.crossed || state.breakpoint.sloMs === sloMs
					? state.breakpoint
					: notCrossed(sloMs);
			// Stops at the first whole-second reading, which an uncrossed run reaches
			// within its opening ticks - this is not a scan of the retained buffer.
			let seenReading = !bp.crossed && state.historicalMetrics.some(hasSecondPercentiles);
			for (const m of batch) {
				peakReading = foldPeakReading(peakReading, m);
				lagSince = foldLagStreak(lagSince, m);
				if (!bp.crossed) bp = breakpointAt(m, sloMs, !seenReading) ?? bp;
				seenReading ||= hasSecondPercentiles(m);
			}

			return {
				currentMetrics: batch[batch.length - 1],
				historicalMetrics: newHistory,
				peakConcurrency: peakReading.peak,
				p99AtPeakMs: peakReading.p99Ms,
				dispatchLagSinceSeconds: lagSince,
				breakpoint: bp,
			};
		}),

	/**
	 * Append scrapes, bounded by the same tick ceiling the series is.
	 *
	 * A scrape can be configured faster than the tick cadence, so the bound is
	 * on this array's own length rather than derived from the ticks - otherwise
	 * a 250ms scrape over an overnight soak would grow without limit beside a
	 * series that is trimmed.
	 */
	addMonitorSamples: (batch) =>
		set((state) => {
			if (batch.length === 0) return state;
			const merged = [...state.monitorSamples, ...batch];
			const cap = state.maxRetainedTicks;
			return { monitorSamples: merged.length > cap ? merged.slice(-cap) : merged };
		}),

	setFinalReport: (report) =>
		set((state) => {
			// A live run's report is a snapshot, not a final one, whichever caller
			// fetched it (#1925).
			if (isRunInProgress(report.metadata?.status)) return state;
			return {
				finalReport: report,
				mode: finalModeFor(state.mode, report.metadata?.status),
				isStreaming: false,
			};
		}),

	setError: (error) => set({ error }),
	setStopping: (stopping) => set({ isStopping: stopping }),
}));
