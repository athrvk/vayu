/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestDashboard Types
 *
 * Centralized type definitions for the load test dashboard
 */

import type { LoadTestMetrics, RunReport } from "@/types";
import type { LoadMode } from "./hooks/useMode";
import type { Breakpoint } from "./utils/computeBreakpoint";

// ============================================================================
// Dashboard State Types
// ============================================================================

export type DashboardMode = "idle" | "running" | "completed" | "stopped";
export type DashboardView = "metrics" | "request-response";

// ============================================================================
// Component Props Types
// ============================================================================

export interface DashboardHeaderProps {
	runId: string;
	mode: DashboardMode;
	isStreaming: boolean;
	isStopping: boolean;
	onStop: () => Promise<void>;
	requestUrl?: string;
	requestMethod?: string;
	elapsedDuration?: number;
	configuration?: {
		mode?: string;
		duration?: number | string | undefined;
		targetRps?: number;
		concurrency?: number;
		comment?: string;
	};
}

export interface RunMetadataProps {
	requestUrl?: string;
	requestMethod?: string;
	startTime?: number;
	endTime?: number;
	mode: DashboardMode;
	elapsedDuration: number;
	setupOverhead?: number; // in seconds
	configuration?: {
		mode?: string;
		duration?: number | string | undefined;
		targetRps?: number;
		concurrency?: number;
		comment?: string;
	};
}

export interface MetricsViewProps {
	metrics: DisplayMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	isCompleted: boolean;
	finalReport: RunReport | null;
	targetRps?: number;
	/** Configured concurrency for closed-loop modes (constant_concurrency). */
	concurrency?: number;
	mode?: string;
	rampConfig?: {
		rampUpDurationSeconds?: number;
		startConcurrency?: number;
		targetConcurrency?: number;
	};
}

/**
 * Single derived-metrics bundle the orchestrator computes once (memoized) and
 * passes to the mode-adaptive HeroRow and ModeStatsRow. Centralizing derivation
 * here keeps the hero/stat card variants pure presentational components that
 * read what they need - no card re-derives from raw metrics (Plan 4 gate #9).
 */
export interface DashboardDerived {
	mode: LoadMode;
	isCompleted: boolean;
	// Rates
	targetRps?: number;
	actualRps?: number;
	sendRate?: number;
	throughput?: number;
	currentRps: number;
	avgQueueWaitMs: number;
	// Counts
	totalRequests: number;
	failedRequests: number;
	statusCodes: Record<string, number>;
	requestsExpected: number;
	requestsSent: number;
	// Concurrency
	peakConcurrency: number;
	currentConcurrency: number;
	configuredConcurrency?: number;
	backpressure: number;
	// Latency
	p99Latency: number;
	meanLatency: number;
	medianLatency: number;
	p95Latency: number;
	// Timing
	testDuration?: number;
	elapsedSeconds: number;
	setupOverhead?: number;
	// Drops
	droppedRequests: number;
	showDropped: boolean;
	// Ramp / breakpoint
	rampDeviationPct?: number;
	rampUpDurationSeconds?: number;
	startConcurrency?: number;
	targetConcurrency?: number;
	breakpoint: Breakpoint;
}

export interface RequestResponseViewProps {
	report: RunReport | null;
}

export interface LatencyChartProps {
	data: LoadTestMetrics[];
	isCompleted: boolean;
}

export interface ThroughputChartProps {
	data: LoadTestMetrics[];
	isCompleted: boolean;
}

// ============================================================================
// Derived Types
// ============================================================================

export interface DisplayMetrics {
	requests_completed: number;
	requests_failed: number;
	current_rps: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	// Rate metrics (Open Model)
	send_rate?: number; // Rate at which requests are dispatched to the server
	throughput?: number; // Rate at which responses are received from the server
	// Connection metrics
	backpressure?: number; // Queue depth: requests sent but not yet responded
	current_concurrency?: number; // Number of concurrent HTTP connections
	dropped_requests?: number;
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat (live only).
	requests_sent?: number;
	requests_expected?: number;
}
