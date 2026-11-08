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
	computeBreakpoint,
	notCrossed,
	sloSourceOf,
	type Breakpoint,
	type SloSource,
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
import { isRunInProgress, type TerminalRunStatus } from "@/lib/run-status";

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
	/** A capacity run's own p99 budget (ms), the search's stop line; absent in every other mode. */
	sloMs?: number;
	/** The `latencyP99Ms` threshold the run declared (ms); absent when it set none. */
	latencyP99Ms?: number;
}

/** A capacity run's own p99 budget, the line its search stops on; no other mode has one. */
function capacitySloMs(config: LoadTestRunConfig | null): number | undefined {
	return config?.mode === "capacity" ? config.sloMs : undefined;
}

/**
 * The p99 line (ms) the live charts, latency tiles and HDR markers draw: the
 * run's own, which mirrors `runSloMs(report)` for a stored run (#2939). A
 * capacity run's `sloMs` (the line its search stopped on), else its
 * `latencyP99Ms` budget, else `undefined`. The Settings SLO is a client
 * preference, not a property of the run, so it is never the answer.
 */
export function runOwnSloMs(config: LoadTestRunConfig | null): number | undefined {
	return capacitySloMs(config) ?? config?.latencyP99Ms;
}

interface SloJudge {
	sloMs: number;
	sloSource: SloSource;
}

/**
 * The line a run's breakpoint is judged against, and whose it is: a capacity
 * run's own, which its search stopped on, else the Settings threshold. A
 * capacity run judged by the Settings line would draw one budget on the
 * Capacity summary and another on the Saturation card and the chart. A ramp
 * stays Settings-judged even when the run set a p99 budget, so `sloSource` is
 * "run" only where the two are the same number (#2939). This is the judge only;
 * what the charts draw is {@link runOwnSloMs}, as History's is.
 */
function sloJudgeFor(config: LoadTestRunConfig | null): SloJudge {
	const sloMs = capacitySloMs(config) ?? useClientSettingsStore.getState().sloThresholdMs;
	return { sloMs, sloSource: sloSourceOf(sloMs, runOwnSloMs(config)) };
}

/** The breakpoint of a run no tick has crossed yet, judged by `judge`. */
function uncrossedBy(judge: SloJudge): Breakpoint {
	return notCrossed(judge.sloMs, judge.sloSource);
}

/** How a run the dashboard holds ended, as its pill names it. */
export type FinishedKind = TerminalRunStatus;

/**
 * Where the run the dashboard holds stands (#3351). One field rather than the
 * `mode` / `isStreaming` / `error` / `finalReport` flags it replaced, which
 * could disagree: a stream error left `isStreaming` true beside its message,
 * and "awaiting the report" was only the absence of every other flag.
 *
 * - `idle`: no run yet.
 * - `streaming`: the SSE stream is attached and ticks arrive.
 * - `streamLost`: the stream ended (an error, a drop, a collection run taking
 *   the client) while the engine still runs the load test; `message` is the
 *   dashboard's callout body, and Reconnect is the way back.
 * - `awaitingReport`: the stream closed, or the user stopped the run, and the
 *   stored report is on its way. `stopped` is the user's Stop, which decides
 *   the run's ending whatever the report says.
 * - `reportError`: the report fetch gave up; Retry returns to `awaitingReport`.
 * - `finished`: the report landed, and `kind` is how the run ended.
 */
export type DashboardPhase =
	| { phase: "idle" }
	| { phase: "streaming" }
	| { phase: "streamLost"; message: string }
	| { phase: "awaitingReport"; stopped: boolean }
	| { phase: "reportError"; message: string; stopped: boolean }
	| { phase: "finished"; kind: FinishedKind; report: RunReport };

/**
 * Whether the run the dashboard holds may still be executing on the engine:
 * the one answer the header's pill and Stop button, the keep-awake prompt, the
 * URL bar and the builder's single-run guard read.
 *
 * A lost stream is live: the engine keeps running the load test, so the pill
 * still says Running beside the lost-stream callout. Awaiting the report is
 * live until the report says otherwise, unless the user's Stop ended it. A
 * failed report fetch is not: the stream had already closed, and holding the
 * builder on a read that cannot answer would lock out every new run until the
 * engine did.
 */
export function isDashboardRunLive(phase: DashboardPhase): boolean {
	switch (phase.phase) {
		case "streaming":
		case "streamLost":
			return true;
		case "awaitingReport":
			return !phase.stopped;
		default:
			return false;
	}
}

/**
 * How the run ended as far as the dashboard knows: the report's kind once it
 * landed, "stopped" from the user's Stop before it, and null while neither has
 * happened. Never set while {@link isDashboardRunLive} is true.
 */
export function dashboardRunEnding(phase: DashboardPhase): FinishedKind | null {
	if (phase.phase === "finished") return phase.kind;
	if (phase.phase === "awaitingReport" || phase.phase === "reportError") {
		return phase.stopped ? "stopped" : null;
	}
	return null;
}

/**
 * The kind a finished run settles in. A stop the user asked for stays
 * "stopped" whatever the report says; otherwise the engine's own status
 * decides, so a failed run is not shown as a neutral "completed" (#1932).
 */
function finishedKindFor(phase: DashboardPhase, reportStatus: string | undefined): FinishedKind {
	if (dashboardRunEnding(phase) === "stopped" || reportStatus === "stopped") return "stopped";
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
	/** Where {@link currentRunId} stands; see {@link DashboardPhase}. */
	phase: DashboardPhase;
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
	/** A Stop request for the held run is in flight. */
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

	/*
	 * Actions. `startRun` is the one that replaces the held run; every other
	 * writer names the run it speaks for, and a write for a run the store is
	 * not holding is dropped, as `execution-events-store` does. A continuation
	 * that outlived its run (a report fetch, a close handler, a Stop request)
	 * must not paint a newer run.
	 */
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
	setRunConfig: (
		runId: string,
		config: LoadTestRunConfig,
		requestInfo: LoadTestRequestInfo | null
	) => void;
	/** The engine accepted the user's Stop: the run awaits its report as stopped. */
	stopRun: (runId: string) => void;
	/** The stream attached (or re-attached, which is Reconnect) to a live run. */
	streamOpened: (runId: string) => void;
	/** The stream ended while the engine still runs the load test. */
	streamLost: (runId: string, message: string) => void;
	/** The stream closed; the stored report decides how the run ended. */
	streamClosed: (runId: string) => void;
	setLiveWindowSeconds: (seconds: number | null) => void;
	setMaxRetainedTicks: (ticks: number) => void;
	addMetricsBatch: (runId: string, batch: LoadTestMetrics[]) => void;
	addMonitorSamples: (runId: string, batch: MonitorSample[]) => void;
	setFinalReport: (runId: string, report: RunReport) => void;
	/** The report fetch gave up; `message` is the callout body. */
	reportFailed: (runId: string, message: string) => void;
	/** Retry after {@link reportFailed}: the report is awaited again. */
	retryReport: (runId: string) => void;
	setStopping: (runId: string, stopping: boolean) => void;
}

const IDLE: DashboardPhase = { phase: "idle" };
const STREAMING: DashboardPhase = { phase: "streaming" };

/**
 * Apply `next` to the state when it holds `runId`; otherwise return the state
 * itself, so zustand notifies nobody. The writers that fold data in
 * (`addMetricsBatch`, `addMonitorSamples`, `setFinalReport`) make the same
 * comparison inside their own early return.
 */
function forRun(
	state: DashboardState,
	runId: string,
	next: (state: DashboardState) => Partial<DashboardState>
): Partial<DashboardState> {
	return state.currentRunId === runId ? next(state) : state;
}

/**
 * The held run with the config and request it was started without, its
 * breakpoint re-judged where the config moves the line.
 */
function withRunConfig(
	state: DashboardState,
	config: LoadTestRunConfig,
	requestInfo: LoadTestRequestInfo | null
): Partial<DashboardState> {
	const patch = { loadTestConfig: config, requestInfo: requestInfo ?? state.requestInfo };
	// A run started elsewhere (an MCP agent's) streams ticks before its config
	// is read, so they were judged against the Settings threshold. A capacity
	// run's own line replaces that verdict, from the ticks still retained.
	const judge = sloJudgeFor(config);
	const { breakpoint } = state;
	if (judge.sloMs !== breakpoint.sloMs) {
		if (capacitySloMs(config) === undefined) return patch;
		const rejudged = computeBreakpoint(
			state.historicalMetrics,
			judge.sloMs,
			runOwnSloMs(config)
		);
		return { ...patch, breakpoint: rejudged };
	}
	// The same number can be the run's budget or only the Settings default, and
	// the config says which; the verdict itself does not move.
	if (judge.sloSource === breakpoint.sloSource) return patch;
	return { ...patch, breakpoint: { ...breakpoint, sloSource: judge.sloSource } };
}

export const useDashboardStore = create<DashboardState>((set) => ({
	currentRunId: null,
	phase: IDLE,
	currentMetrics: null,
	historicalMetrics: [],
	monitorSamples: [],
	isStopping: false,
	loadTestConfig: null,
	requestInfo: null,
	sourceRequestId: null,
	peakConcurrency: 0,
	breakpoint: notCrossed(null, "settings"),
	p99AtPeakMs: undefined,
	dispatchLagSinceSeconds: null,
	liveWindowSeconds: initialLiveWindowSeconds(),
	maxRetainedTicks: DEFAULT_MAX_RETAINED_TICKS,

	startRun: (runId, config, requestInfo, sourceRequestId) =>
		set({
			currentRunId: runId,
			phase: STREAMING,
			currentMetrics: null,
			historicalMetrics: [],
			monitorSamples: [],
			isStopping: false,
			loadTestConfig: config ?? null,
			requestInfo: requestInfo ?? null,
			sourceRequestId: sourceRequestId ?? null,
			peakConcurrency: 0,
			breakpoint: uncrossedBy(sloJudgeFor(config ?? null)),
			p99AtPeakMs: undefined,
			dispatchLagSinceSeconds: null,
		}),

	setRunConfig: (runId, config, requestInfo) =>
		set((state) => forRun(state, runId, (s) => withRunConfig(s, config, requestInfo))),

	// From a lost stream too: the callout is about a run still going, and this
	// one was stopped (#1925). A run already settled has nothing left to stop.
	stopRun: (runId) =>
		set((state) =>
			forRun(state, runId, (s) =>
				isDashboardRunLive(s.phase)
					? { phase: { phase: "awaitingReport", stopped: true } }
					: s
			)
		),

	// Live phases only: a stream re-attached to a run that has settled or been
	// stopped must not raise it back to Running.
	streamOpened: (runId) =>
		set((state) =>
			forRun(state, runId, (s) => (isDashboardRunLive(s.phase) ? { phase: STREAMING } : s))
		),

	streamLost: (runId, message) =>
		set((state) =>
			forRun(state, runId, (s) =>
				isDashboardRunLive(s.phase) ? { phase: { phase: "streamLost", message } } : s
			)
		),

	// Only from `streaming`: a close after a lost stream keeps the callout, and
	// one after a Stop or a landed report has nothing to add.
	streamClosed: (runId) =>
		set((state) =>
			forRun(state, runId, (s) =>
				s.phase.phase === "streaming"
					? { phase: { phase: "awaitingReport", stopped: false } }
					: s
			)
		),

	setLiveWindowSeconds: (seconds) => set({ liveWindowSeconds: seconds }),

	setMaxRetainedTicks: (ticks) =>
		set({ maxRetainedTicks: ticks > 0 ? ticks : DEFAULT_MAX_RETAINED_TICKS }),

	addMetricsBatch: (runId, batch) =>
		set((state) => {
			if (state.currentRunId !== runId || batch.length === 0) return state;
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
			const judge = sloJudgeFor(state.loadTestConfig);
			let lagSince = state.dispatchLagSinceSeconds;
			let peakReading = { peak: state.peakConcurrency, p99Ms: state.p99AtPeakMs };
			// An uncrossed breakpoint names the line it is being judged against, so a
			// threshold changed mid-run is followed until the first crossing latches.
			let bp =
				state.breakpoint.crossed ||
				(state.breakpoint.sloMs === judge.sloMs &&
					state.breakpoint.sloSource === judge.sloSource)
					? state.breakpoint
					: uncrossedBy(judge);
			// Stops at the first whole-second reading, which an uncrossed run reaches
			// within its opening ticks - this is not a scan of the retained buffer.
			let seenReading = !bp.crossed && state.historicalMetrics.some(hasSecondPercentiles);
			for (const m of batch) {
				peakReading = foldPeakReading(peakReading, m);
				lagSince = foldLagStreak(lagSince, m);
				if (!bp.crossed)
					bp = breakpointAt(m, judge.sloMs, judge.sloSource, !seenReading) ?? bp;
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
	addMonitorSamples: (runId, batch) =>
		set((state) => {
			if (state.currentRunId !== runId || batch.length === 0) return state;
			const merged = [...state.monitorSamples, ...batch];
			const cap = state.maxRetainedTicks;
			return { monitorSamples: merged.length > cap ? merged.slice(-cap) : merged };
		}),

	setFinalReport: (runId, report) =>
		set((state) => {
			// A live run's report is a snapshot, not a final one, whichever caller
			// fetched it (#1925).
			if (state.currentRunId !== runId || isRunInProgress(report.metadata?.status)) {
				return state;
			}
			const kind = finishedKindFor(state.phase, report.metadata?.status);
			return { phase: { phase: "finished", kind, report } };
		}),

	reportFailed: (runId, message) =>
		set((state) =>
			forRun(state, runId, (s) =>
				s.phase.phase === "awaitingReport"
					? { phase: { phase: "reportError", message, stopped: s.phase.stopped } }
					: s
			)
		),

	retryReport: (runId) =>
		set((state) =>
			forRun(state, runId, (s) =>
				s.phase.phase === "reportError"
					? { phase: { phase: "awaitingReport", stopped: s.phase.stopped } }
					: s
			)
		),

	setStopping: (runId, stopping) =>
		set((state) => forRun(state, runId, () => ({ isStopping: stopping }))),
}));
