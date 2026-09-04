/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Dashboard State Store (Load Test Metrics)

import { create } from "zustand";
import type { LoadTestMetrics, MonitorSample, RunReport } from "@/types";
import { type Breakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import { useClientSettingsStore } from "./client-settings-store";
import {
	DEFAULT_LIVE_WINDOW,
	liveWindowSeconds as windowSecondsFor,
	DEFAULT_MAX_RETAINED_TICKS,
} from "@/constants/live-window";
import type { DashboardMode, DashboardView } from "@/modules/dashboard/types";

/**
 * Retention seeded before the window is known. The real value is the engine's
 * `liveReplayWindowMs`, which `useLiveChartSettings` pushes in once the config
 * query resolves - it cannot be read synchronously here the way the old
 * localStorage preference could. Seeding the module default rather than `null`
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
}

/**
 * Seconds in a duration the engine accepts: a number with an optional
 * `ms`/`s`/`m`/`h` unit, where a bare number is seconds (see
 * `parse_duration_ms` in `engine/src/core/load_strategy.cpp`). `null` for
 * anything else, including the absent duration of an open-ended run.
 */
const DURATION_UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

function durationSeconds(duration: string | undefined): number | null {
	if (!duration) return null;
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(duration);
	if (!match) return null;
	const seconds = Number(match[1]) * (match[2] ? DURATION_UNIT_SECONDS[match[2]] : 1);
	return seconds > 0 ? seconds : null;
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

const INITIAL_BREAKPOINT: Breakpoint = {
	crossed: false,
	concurrency: null,
	timeSeconds: null,
	p99Ms: null,
};

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
	activeView: DashboardView;
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
	 * Live retention window in seconds (null = full run, bounded by
	 * {@link maxRetainedTicks}). Drives the time-based trim in
	 * {@link addMetricsBatch}. Kept in sync by useLiveChartSettings.
	 */
	liveWindowSeconds: number | null;
	/**
	 * Ceiling on retained ticks whatever the window - the memory backstop, and
	 * the same `liveMaxRetainedTicks` value the engine bounds its replay ring
	 * with, so this side never discards what the engine went to the trouble of
	 * retaining. Also synced by useLiveChartSettings.
	 */
	maxRetainedTicks: number;

	// Actions
	startRun: (
		runId: string,
		config?: LoadTestRunConfig,
		requestInfo?: LoadTestRequestInfo,
		sourceRequestId?: string | null
	) => void;
	stopRun: () => void;
	setStreaming: (streaming: boolean) => void;
	setLiveWindowSeconds: (seconds: number | null) => void;
	setMaxRetainedTicks: (ticks: number) => void;
	addMetricsBatch: (batch: LoadTestMetrics[]) => void;
	addMonitorSamples: (batch: MonitorSample[]) => void;
	setFinalReport: (report: RunReport) => void;
	setError: (error: string | null) => void;
	setActiveView: (view: DashboardView) => void;
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
	activeView: "metrics",
	isStopping: false,
	loadTestConfig: null,
	requestInfo: null,
	sourceRequestId: null,
	peakConcurrency: 0,
	breakpoint: INITIAL_BREAKPOINT,
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
			activeView: "metrics",
			isStopping: false,
			loadTestConfig: config ?? null,
			requestInfo: requestInfo ?? null,
			sourceRequestId: sourceRequestId ?? null,
			peakConcurrency: 0,
			breakpoint: INITIAL_BREAKPOINT,
		}),

	stopRun: () =>
		set({
			mode: "stopped",
			isStreaming: false,
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

			// Fold the new ticks into the running aggregates. Both are monotone:
			// peak only grows, breakpoint is latched on the first SLO crossing -
			// so we walk each batch entry exactly once, never the full history.
			const sloMs = useClientSettingsStore.getState().sloThresholdMs;
			let peak = state.peakConcurrency;
			let bp = state.breakpoint;
			for (const m of batch) {
				if (m.current_concurrency > peak) peak = m.current_concurrency;
				if (!bp.crossed) {
					const p99 = m.latency_p99_ms ?? 0;
					if (p99 > sloMs) {
						bp = {
							crossed: true,
							concurrency: m.current_concurrency,
							timeSeconds: m.elapsed_seconds,
							p99Ms: p99,
						};
					}
				}
			}

			return {
				currentMetrics: batch[batch.length - 1],
				historicalMetrics: newHistory,
				peakConcurrency: peak,
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
		set((state) => ({
			finalReport: report,
			// Set mode based on report status - keep "stopped" if already stopped
			mode:
				state.mode === "stopped"
					? "stopped"
					: report.metadata?.status === "stopped"
						? "stopped"
						: "completed",
			isStreaming: false,
		})),

	setError: (error) => set({ error }),
	setActiveView: (view) => set({ activeView: view }),
	setStopping: (stopping) => set({ isStopping: stopping }),
}));
