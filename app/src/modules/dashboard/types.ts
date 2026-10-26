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

import type { CapacityResult } from "@/components/shared/capacityStop";
import type { RunOutcome } from "@/components/shared/run-outcome";
import type { LiveCapacityState, LoadTestMetrics } from "@/types";
import type { LoadMode } from "./hooks/useMode";
import type { Breakpoint } from "./utils/computeBreakpoint";
import type { DispatchStatus } from "./utils/dispatchLag";

// ============================================================================
// Dashboard State Types
// ============================================================================

export type DashboardMode = "idle" | "running" | "completed" | "stopped" | "failed";

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
	/**
	 * The collection a collection load run is aimed at, and how many steps one
	 * pass over it has (#2270). Shown where the URL would be, for a run that
	 * has none; ignored when there is a `requestUrl`. Primitives, like every
	 * prop here: the header is memo'd on `Object.is`.
	 */
	collectionName?: string;
	stepCount?: number;
	/** The run's own line, shown under the identity - see `RunComment`. */
	comment?: string;
	/**
	 * The finished run the header offers to export (#2139), and the report's
	 * request URL and method its baseline is looked up by. Set only once the
	 * report is on screen, so a streaming run never mounts the menu.
	 */
	exportRunId?: string;
	exportRequestUrl?: string;
	exportRequestMethod?: string;
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
		/** Whether its numbers were read as numbers (issue #2540); printed beside the name. */
		dataFileCastNumbers?: boolean;
	};
}

export interface MetricsViewProps {
	metrics: DisplayMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	targetRps?: number;
	/** Configured concurrency for closed-loop modes (constant_concurrency). */
	concurrency?: number;
	mode?: string;
	/** The configured run duration in seconds; absent for an open-ended run. */
	runDurationSeconds?: number;
	rampConfig?: {
		rampUpDurationSeconds?: number;
		startConcurrency?: number;
		targetConcurrency?: number;
	};
}

/** Where a Stop ended a run against its plan; the card states it beside a pace-judged figure (#2805). */
export interface StoppedAt {
	/** Percent of the planned requests the run reached: the report's `rateControl.achievement`. */
	planSharePct: number;
	/** The configured duration, seconds. */
	plannedSeconds: number;
}

/**
 * Single derived-metrics bundle the orchestrator computes once (memoized) and
 * passes to the mode-adaptive HeroRow and ModeStatsRow. Centralizing derivation
 * here keeps the hero/stat card variants pure presentational components that
 * read what they need - no card re-derives from raw metrics. `MetricsView` is
 * the one producer; see "Code-quality gates" in this module's README.
 */
/** `sending`: completions at the end of sending over the sending window (#2882). `wholeRun`: the drain-inclusive average. */
export type ReceivedWindow = "sending" | "wholeRun";

export interface DashboardDerived {
	mode: LoadMode;
	isCompleted: boolean;
	// Rates
	targetRps?: number;
	/** Requests sent over the sending window, req/s (#2392) - not completions over wall time. */
	actualRps?: number;
	/** Percent of the requests owed over that window that were sent; the Rate fidelity card's value. */
	rateAchievementPct?: number;
	/** Only on a stopped report judged by pace; absent live and when the plan is unknown. */
	stoppedAt?: StoppedAt;
	sendRate?: number;
	/** Completions over the whole run, drain included; live, the run-cumulative rate. */
	throughput?: number;
	/**
	 * The received rate the Send / Throughput pair prints and `dispatchStatus`
	 * judges, set by `reportToDerived` only. Absent live, where the card falls
	 * back to `throughput`.
	 */
	receivedRate?: number;
	/** The window `receivedRate` was measured over. */
	receivedWindow?: ReceivedWindow;
	/**
	 * Verdict of the Send / Throughput chip, judged by `utils/dispatchLag.ts` on
	 * the pair its producer chooses (the live windowed rates; a finished run's
	 * cumulative ones). Absent where either rate is unknown: no chip.
	 */
	dispatchStatus?: DispatchStatus;
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
	/**
	 * Mean requests on the wire: the trailing window's on a live tick, the whole
	 * run's on a finished one. The utilisation card reads it instead of
	 * `currentConcurrency`, which is a 0-and-N square wave for virtual users in a
	 * timer wait (#2821). Absent for a run stored before the mean existed.
	 */
	avgInFlight?: number;
	configuredConcurrency?: number;
	backpressure: number;
	// Latency: absent for a stored run whose latency was not recorded (#2938)
	p99Latency?: number;
	meanLatency?: number;
	medianLatency?: number;
	p95Latency?: number;
	// Timing
	testDuration?: number;
	elapsedSeconds: number;
	/** Run entry to load start, setup script included; absent for a run stored before it was measured. */
	setupOverhead?: number;
	/** Load end to teardown finished. */
	cleanupOverhead?: number;
	// Drops
	droppedRequests: number;
	/** `constant_rps` requests skipped after a generator stall (#2911); 0 where there were none. */
	skippedRequests: number;
	/** The schedule time the skipped requests cover, in milliseconds. */
	stalledMs: number;
	showDropped: boolean;
	// Ramp / breakpoint
	rampDeviationPct?: number;
	rampUpDurationSeconds?: number;
	startConcurrency?: number;
	targetConcurrency?: number;
	breakpoint: Breakpoint;
	/**
	 * The p99 line (ms) the stored run declared for itself, from `runSloMs`; the
	 * only SLO its charts and latency tiles draw. Absent for a run with neither a
	 * capacity budget nor a p99 budget, and absent live (the live view reads `runOwnSloMs` off the store). Distinct from
	 * `breakpoint.sloMs`, which a non-capacity run judges against the Settings SLO.
	 */
	runSloMs?: number;
	/**
	 * What a finished capacity run's search found, from the report. Absent live
	 * (the engine publishes the stop reason only in the report, which replaces
	 * the live view once the run ends) and for every other mode; the Saturation
	 * card of a capacity run reads it as "still searching" until it exists.
	 */
	capacity?: CapacityResult;
	/**
	 * Where a capacity search stands, off the latest live frame (#2928). Absent
	 * for a stored run, an engine from before the block and every other mode.
	 */
	liveCapacity?: LiveCapacityState;
	/**
	 * Worst whole-second p99 (ms) among the ticks at the run's peak load; absent
	 * where no per-tick series reached the peak, and the stat falls back to
	 * `p99Latency`.
	 */
	p99AtPeakMs?: number;
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
	// The latest tick's status map.
	status_codes?: Record<string, number>;
	current_rps: number;
	// Dispatches per second over the same trailing window as `current_rps`.
	current_send_rate?: number;
	latency_p50_ms?: number | null;
	latency_p95_ms?: number | null;
	latency_p99_ms?: number | null;
	// The run's percentiles so far, on a live tick (`LoadTestMetrics`'s own docs).
	cumulative_p50_ms?: number | null;
	cumulative_p95_ms?: number | null;
	cumulative_p99_ms?: number | null;
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	// Rate metrics (Open Model)
	send_rate?: number; // Rate at which requests are dispatched to the server
	throughput?: number; // Rate at which responses are received from the server
	// Connection metrics
	backpressure?: number; // In flight: sent but not yet answered, plus slots a think timer holds
	current_concurrency?: number; // Number of concurrent HTTP connections
	window_avg_in_flight?: number | null; // Mean requests on the wire over the tick's window
	dropped_requests?: number;
	skipped_requests?: number;
	stalled_ms?: number;
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat (live only).
	requests_sent?: number;
	requests_expected?: number;
	// A capacity run's search state (#2928); live only.
	capacity?: LiveCapacityState;
}
