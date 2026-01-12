// Dashboard State Store (Load Test Metrics)

import { create } from "zustand";
import type { LoadTestMetrics, RunReport } from "@/types";

type DashboardMode = "running" | "completed";
type DashboardView = "metrics" | "request-response";

// Config passed when starting a load test (for display during streaming)
export interface LoadTestRunConfig {
	mode?: string;
	duration?: string;
	targetRps?: number;
	concurrency?: number;
	iterations?: number;
	comment?: string;
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
	finalReport: RunReport | null;
	error: string | null;
	activeView: DashboardView;
	isStopping: boolean;
	// Config and request info (available during live streaming)
	loadTestConfig: LoadTestRunConfig | null;
	requestInfo: LoadTestRequestInfo | null;

	// Actions
	startRun: (runId: string, config?: LoadTestRunConfig, requestInfo?: LoadTestRequestInfo) => void;
	stopRun: () => void;
	setStreaming: (streaming: boolean) => void;
	addMetrics: (metrics: LoadTestMetrics) => void;
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
		}),

	stopRun: () =>
		set({
			mode: "completed",
			isStreaming: false,
		}),

	setStreaming: (streaming) => set({ isStreaming: streaming }),

	addMetrics: (metrics) =>
		set((state) => {
			// Keep all historical metrics with reasonable limit (10000 points max)
			const newHistory = [...state.historicalMetrics, metrics];
			// Trim to last 10000 points if needed (prevents memory issues on very long tests)
			const trimmedHistory = newHistory.length > 10000
				? newHistory.slice(-10000)
				: newHistory;

			return {
				currentMetrics: metrics,
				historicalMetrics: trimmedHistory,
			};
		}),

	setFinalReport: (report) =>
		set({
			finalReport: report,
			mode: "completed",
			isStreaming: false,
		}),

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
