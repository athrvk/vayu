// Dashboard State Store (Load Test Metrics)

import { create } from "zustand";
import type { LoadTestMetrics, RunReport } from "@/types";

type DashboardMode = "running" | "completed";
type DashboardView = "metrics" | "request-response";

interface DashboardState {
	currentRunId: string | null;
	mode: DashboardMode;
	isStreaming: boolean;
	currentMetrics: LoadTestMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	finalReport: RunReport | null;
	error: string | null;
	activeView: DashboardView;

	// Actions
	startRun: (runId: string) => void;
	stopRun: () => void;
	setStreaming: (streaming: boolean) => void;
	addMetrics: (metrics: LoadTestMetrics) => void;
	setFinalReport: (report: RunReport) => void;
	setError: (error: string | null) => void;
	setActiveView: (view: DashboardView) => void;
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

	startRun: (runId) =>
		set({
			currentRunId: runId,
			mode: "running",
			isStreaming: true,
			currentMetrics: null,
			historicalMetrics: [],
			finalReport: null,
			error: null,
			activeView: "metrics",
		}),

	stopRun: () =>
		set({
			mode: "completed",
			isStreaming: false,
		}),

	setStreaming: (streaming) => set({ isStreaming: streaming }),

	addMetrics: (metrics) =>
		set((state) => ({
			currentMetrics: metrics,
			historicalMetrics: [...state.historicalMetrics, metrics],
		})),

	setFinalReport: (report) =>
		set({
			finalReport: report,
			mode: "completed",
			isStreaming: false,
		}),

	setError: (error) => set({ error }),
	setActiveView: (view) => set({ activeView: view }),

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
