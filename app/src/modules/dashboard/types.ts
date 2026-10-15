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

import type { RunOutcome } from "@/components/shared/run-outcome";
import type { LoadTestMetrics, RunReport } from "@/types";
import type { LoadMode } from "./hooks/useMode";
import type { Breakpoint } from "./utils/computeBreakpoint";

// ============================================================================
// Dashboard State Types
// ============================================================================

export type DashboardMode = "idle" | "running" | "completed" | "stopped" | "failed";
export type DashboardView = "metrics" | "request-response";

// ============================================================================
// Component Props Types
// ============================================================================

export interface DashboardHeaderProps {
	mode: DashboardMode;
	isStreaming: boolean;
	isStopping: boolean;
	onStop: () => Promise<void>;
	requestUrl?: string;
	requestMethod?: string;
	elapsedDuration?: number;
	/**
	 * The finished run's verdict (`run-outcome.ts`), so a `completed` pill does not
	 * wear the success tick for a run that missed a budget or was never judged.
	 * The string, not the judgement: the header is memo'd on `Object.is`, and a
	 * fresh `{outcome, reason}` per render would defeat it (#1714).
	 */
	outcome?: RunOutcome;
	configuration?: {
		mode?: string;
		duration?: number | string | undefined;
		targetRps?: number;
		concurrency?: number;
		comment?: string;
		/**
		 * How many `data` rows the run bound (issue #993): off the stored
		 * snapshot once the report loads - which keeps the count in the rows'
		 * place, since the rows themselves are never persisted - and off the
		 * launch config while live. Absent for a run without a data file.
		 */
		dataRowCount?: number;
		/**
		 * The data file's display name and the SHA-256 of its bytes (issue
		 * #2051), from the same two places as {@link dataRowCount}. The name
		 * is printed beside the count; the hash is never shown, it only lets
		 * a surface that can resolve a collection say the file has since
		 * changed. Never a path.
		 */
		dataFileName?: string;
		dataFileHash?: string;
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
 * read what they need - no card re-derives from raw metrics. `MetricsView` is
 * the one producer; see "Code-quality gates" in this module's README.
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
	/** Errors by the one definition: `httpErrors + noResponse` (issue #2124). */
	failedRequests: number;
	/** Of `failedRequests`, those that got a response with an error status. */
	httpErrors: number;
	/** Of `failedRequests`, those that got no response at all. */
	noResponse: number;
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

// ============================================================================
// Derived Types
// ============================================================================

export interface DisplayMetrics {
	requests_completed: number;
	requests_failed: number;
	// The split of `requests_failed`; absent on a tick stored by an older engine.
	http_errors?: number;
	no_response?: number;
	// The latest tick's status map. The completed view builds this from the
	// report, which carries its own `statusCodes`, so it is absent there.
	status_codes?: Record<string, number>;
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
	backpressure?: number; // In flight: sent but not yet answered, plus slots a think timer holds
	current_concurrency?: number; // Number of concurrent HTTP connections
	dropped_requests?: number;
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat (live only).
	requests_sent?: number;
	requests_expected?: number;
}
