/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Dashboard State Store (Load Test Metrics)

import { create } from "zustand";
import type { LoadTestMetrics, RunReport } from "@/types";
import { DEFAULT_SLO_MS, type Breakpoint } from "@/modules/dashboard/utils/computeBreakpoint";

type DashboardMode = "running" | "completed" | "stopped";
type DashboardView = "metrics" | "request-response";

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

// Request info passed when starting a load test
export interface LoadTestRequestInfo {
	method: string;
	url: string;
}

/**
 * Cap historical metrics at ~3000 points. With the engine at 10 Hz and the UI
 * commit throttle at 2 Hz buffering every tick (load-test-service.ts), this is
 * ~5 minutes of full-fidelity history before the oldest points roll off — long
 * enough for a typical load-test session, short enough to keep chart slicing
 * cheap.
 */
const HISTORICAL_METRICS_CAP = 3000;

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
	finalReport: RunReport | null;
	error: string | null;
	activeView: DashboardView;
	isStopping: boolean;
	// Config and request info (available during live streaming)
	loadTestConfig: LoadTestRunConfig | null;
	requestInfo: LoadTestRequestInfo | null;
	/**
	 * Running monotonic aggregates updated on each tick in {@link addMetricsBatch}.
	 * Stored here instead of recomputed in MetricsView so that consumers see O(1)
	 * updates per tick rather than a full scan of {@link historicalMetrics} (which
	 * holds up to {@link HISTORICAL_METRICS_CAP} entries). See PR #26 / #25.
	 */
	peakConcurrency: number;
	breakpoint: Breakpoint;

	// Actions
	startRun: (
		runId: string,
		config?: LoadTestRunConfig,
		requestInfo?: LoadTestRequestInfo
	) => void;
	stopRun: () => void;
	setStreaming: (streaming: boolean) => void;
	addMetricsBatch: (batch: LoadTestMetrics[]) => void;
	setFinalReport: (report: RunReport) => void;
	setError: (error: string | null) => void;
	setActiveView: (view: DashboardView) => void;
	setStopping: (stopping: boolean) => void;
	reset: () => void;

	// Helpers
	getLatestMetrics: () => LoadTestMetrics | null;
	getMetricsWindow: (seconds: number) => LoadTestMetrics[];
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
	currentRunId: null,
	mode: "running",
	isStreaming: false,
	currentMetrics: null,
	historicalMetrics: [],
	finalReport: null,
	error: null,
	activeView: "metrics",
	isStopping: false,
	loadTestConfig: null,
	requestInfo: null,
	peakConcurrency: 0,
	breakpoint: INITIAL_BREAKPOINT,

	startRun: (runId, config, requestInfo) =>
		set({
			currentRunId: runId,
			mode: "running",
			isStreaming: true,
			currentMetrics: null,
			historicalMetrics: [],
			finalReport: null,
			error: null,
			activeView: "metrics",
			isStopping: false,
			loadTestConfig: config ?? null,
			requestInfo: requestInfo ?? null,
			peakConcurrency: 0,
			breakpoint: INITIAL_BREAKPOINT,
		}),

	stopRun: () =>
		set({
			mode: "stopped",
			isStreaming: false,
		}),

	setStreaming: (streaming) => set({ isStreaming: streaming }),

	addMetricsBatch: (batch) =>
		set((state) => {
			if (batch.length === 0) return state;
			const newHistory = [...state.historicalMetrics, ...batch].slice(
				-HISTORICAL_METRICS_CAP
			);

			// Fold the new ticks into the running aggregates. Both are monotone:
			// peak only grows, breakpoint is latched on the first SLO crossing —
			// so we walk each batch entry exactly once, never the full history.
			let peak = state.peakConcurrency;
			let bp = state.breakpoint;
			for (const m of batch) {
				if (m.current_concurrency > peak) peak = m.current_concurrency;
				if (!bp.crossed) {
					const p99 = m.latency_p99_ms ?? 0;
					if (p99 > DEFAULT_SLO_MS) {
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

	reset: () =>
		set({
			currentRunId: null,
			mode: "running",
			isStreaming: false,
			currentMetrics: null,
			historicalMetrics: [],
			finalReport: null,
			error: null,
			activeView: "metrics",
			isStopping: false,
			loadTestConfig: null,
			requestInfo: null,
			peakConcurrency: 0,
			breakpoint: INITIAL_BREAKPOINT,
		}),

	// Helpers
	getLatestMetrics: () => {
		const { historicalMetrics } = get();
		return historicalMetrics.length > 0
			? historicalMetrics[historicalMetrics.length - 1]
			: null;
	},

	getMetricsWindow: (seconds) => {
		const { historicalMetrics } = get();
		if (historicalMetrics.length === 0) return [];

		const latest = historicalMetrics[historicalMetrics.length - 1];
		const cutoffTime = latest.timestamp - seconds * 1000;

		return historicalMetrics.filter((m) => m.timestamp >= cutoffTime);
	},
}));
