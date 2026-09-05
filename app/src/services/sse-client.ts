/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// SSE Client - Server-Sent Events for real-time load test metrics

import { API_ENDPOINTS } from "@/config/api-endpoints";
import { STEP_OUTCOMES } from "@/types";
import type {
	LoadTestMetrics,
	MonitorSample,
	ResponseValidation,
	ScenarioRunPlanEvent,
	ScenarioStepEvent,
	StepOutcome,
	StepTestTally,
} from "@/types";

/** Raw camelCase metrics blob as emitted by the engine SSE stream. */
interface RawSseMetrics {
	timestamp?: number;
	elapsedSeconds?: number;
	totalRequests?: number;
	totalErrors?: number;
	currentRps?: number;
	activeConnections?: number;
	latencyP50Ms?: number;
	latencyP95Ms?: number;
	latencyP99Ms?: number;
	avgLatencyMs?: number;
	sendRate?: number;
	throughput?: number;
	backpressure?: number;
	droppedRequests?: number;
	avgQueueWaitMs?: number;
	requestsSent?: number;
	requestsExpected?: number;
	bytesSent?: number;
	bytesReceived?: number;
	statusCodes?: Record<string, number>;
}

/** Map the engine's camelCase SSE blob to the frontend LoadTestMetrics shape. */
export function mapSseMetrics(m: RawSseMetrics): LoadTestMetrics {
	return {
		timestamp: m.timestamp || Date.now(),
		elapsed_seconds: m.elapsedSeconds || 0,
		requests_completed: m.totalRequests || 0,
		requests_failed: m.totalErrors || 0,
		current_rps: m.currentRps || 0,
		current_concurrency: m.activeConnections || 0,
		latency_p50_ms: m.latencyP50Ms || 0,
		latency_p95_ms: m.latencyP95Ms || 0,
		latency_p99_ms: m.latencyP99Ms || 0,
		avg_latency_ms: m.avgLatencyMs || 0,
		bytes_sent: m.bytesSent || 0,
		bytes_received: m.bytesReceived || 0,
		// Rate metrics (Open Model)
		send_rate: m.sendRate || 0,
		throughput: m.throughput || 0,
		backpressure: m.backpressure || 0,
		dropped_requests: m.droppedRequests || 0,
		avg_queue_wait_ms: m.avgQueueWaitMs || 0,
		requests_sent: m.requestsSent || 0,
		requests_expected: m.requestsExpected || 0,
		status_codes: m.statusCodes,
	};
}

/**
 * Narrow a raw `step` payload to the shape the step list renders, or reject it.
 *
 * A malformed event is dropped rather than coerced: a step rendered with
 * `iteration` 0 because the key was missing is a row claiming to be a step the
 * run never reported, and the list keys on `(iteration, stepIndex)`, so a
 * defaulted pair would also collide with a real step's row.
 */
export function parseStepEvent(raw: unknown): ScenarioStepEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.iteration !== "number" || typeof e.stepIndex !== "number") return null;
	if (typeof e.outcome !== "string" || !STEP_OUTCOMES.includes(e.outcome as StepOutcome)) {
		return null;
	}
	return {
		iteration: e.iteration,
		stepIndex: e.stepIndex,
		name: typeof e.name === "string" ? e.name : `Step ${e.stepIndex + 1}`,
		outcome: e.outcome as StepOutcome,
		statusCode: typeof e.statusCode === "number" ? e.statusCode : 0,
		latencyMs: typeof e.latencyMs === "number" ? e.latencyMs : 0,
		// Absent for a run with no data set, and left absent rather than
		// defaulted: a `0` here would read as "row 1 of a data file".
		...(typeof e.dataRowIndex === "number" ? { dataRowIndex: e.dataRowIndex } : {}),
		// The request this step ran (issue #831), so a live row offers the same
		// way back to it that a stored one does. Left absent unless the frame
		// carries a non-empty id: the step card keys the action off its
		// presence, and an empty string would be a link to nothing.
		...(typeof e.requestId === "string" && e.requestId ? { requestId: e.requestId } : {}),
		// The schema verdict (issue #681), passed through as the object the
		// engine wrote rather than re-narrowed field by field: it is the same
		// node the stored trace carries and `validationFromTrace` passes through
		// for exactly this reason - two narrowings of one shape are two places
		// for it to drift. Absent stays absent; a collection bound to no
		// document has no verdict, which is not the same as an empty one.
		...(e.validation && typeof e.validation === "object"
			? { validation: e.validation as ResponseValidation }
			: {}),
		// The assertion tally (issue #724). Narrowed field by field where the
		// verdict above is passed through, because it is two numbers rather
		// than a node with its own reader: both must be numbers or the chip
		// would render `NaN passed`, and a half-read tally is worse than none.
		...(parseTestTally(e.tests) ?? {}),
	};
}

/**
 * The `tests` node of a `step` frame, as `{ tests }` to spread, or `null`.
 *
 * Absent stays absent - a step whose script asserted nothing carries no node,
 * and inventing `{ passed: 0, failed: 0 }` for it would put "0 tests passed"
 * on every step of every scriptless run.
 */
function parseTestTally(raw: unknown): { tests: StepTestTally } | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { passed, failed } = raw as Record<string, unknown>;
	if (typeof passed !== "number" || typeof failed !== "number") return null;
	return { tests: { passed, failed } };
}

/**
 * Narrow a raw `plan` frame to the run's size, or reject it (issue #1398).
 *
 * Same rule as {@link parseStepEvent}, and it matters more here: this frame is
 * a denominator. A field defaulted to `0` would make every fraction computed
 * from it either a division by zero or a bar that is full from the first step,
 * where rejecting the frame leaves the run indeterminate - which is what a
 * client that was told nothing should show.
 */
export function parsePlanEvent(raw: unknown): ScenarioRunPlanEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { stepsPerIteration, iterations, stepsExpected } = raw as Record<string, unknown>;
	if (typeof stepsPerIteration !== "number" || typeof iterations !== "number") return null;
	if (typeof stepsExpected !== "number") return null;
	return { stepsPerIteration, iterations, stepsExpected };
}

/**
 * Narrow a raw `monitor` frame to one scrape, or reject it.
 *
 * Same rule as {@link parseStepEvent}: a frame this client cannot read is
 * dropped rather than coerced. A sample defaulted to `timestamp: 0` would join
 * onto the very start of the run's timeline and draw a reading the target never
 * gave at a moment it was never asked; non-numeric series entries are dropped
 * individually, because the rest of the scrape is still real data.
 */
export function parseMonitorEvent(raw: unknown): MonitorSample | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.timestamp !== "number") return null;
	if (typeof e.series !== "object" || e.series === null) return null;
	const series: Record<string, number> = {};
	for (const [name, value] of Object.entries(e.series as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isFinite(value)) series[name] = value;
	}
	if (Object.keys(series).length === 0) return null;
	return { timestamp: e.timestamp, series };
}

export type SSEMessageHandler = (metrics: LoadTestMetrics) => void;
export type SSEErrorHandler = (error: Error) => void;
/**
 * How a run's stream ended, when the engine said (issue #1415).
 *
 * `null` for a stream that ended without one: a dropped connection, or a
 * completion frame from an engine that predates the status field. The caller
 * converges on the stored report either way, and a null here means "ask it",
 * never "it finished".
 */
export type SSETerminalStatus = "Completed" | "Stopped" | "Failed" | null;

export type SSECloseHandler = (status: SSETerminalStatus) => void;

/**
 * The status off a `complete` frame, or null for anything else.
 *
 * Unknown values are null rather than passed through: the caller decides what
 * a run's end means from this, and an unrecognised string is not a decision
 * either way - it is an engine this client does not understand yet.
 */
export function parseTerminalStatus(raw: string): SSETerminalStatus {
	try {
		const { status } = JSON.parse(raw) as { status?: unknown };
		if (status === "Completed" || status === "Stopped" || status === "Failed") return status;
		return null;
	} catch {
		return null;
	}
}
/**
 * Another run took this client (issue #1417).
 *
 * Not a variant of {@link SSECloseHandler}: a close says the run ended and the
 * subscriber converges on the stored report, where this says only that nobody
 * is watching the run any more. The run itself is still going in the engine.
 */
export type SSESupersededHandler = () => void;
/** One step execution of a scenario run, from the `step` event. */
export type SSEStepHandler = (step: ScenarioStepEvent) => void;
/** The size a collection run resolved to, from its opening `plan` event. */
export type SSEPlanHandler = (plan: ScenarioRunPlanEvent) => void;
/** One scrape of the run's monitored endpoint, from the `monitor` event. */
export type SSEMonitorHandler = (sample: MonitorSample) => void;

export class SSEClient {
	private eventSource: EventSource | null = null;

	/**
	 * How to tell the current subscriber that another run took the client
	 * (issue #1417), for as long as it is the current one.
	 *
	 * The only handler this class holds as state. The rest live as closures on
	 * the `EventSource` they were registered against, which is exactly why one
	 * is needed here: a displaced subscriber's closures go with the socket that
	 * is being closed, so there would be nothing left to call.
	 */
	private onSuperseded: SSESupersededHandler | null = null;

	// Current metrics state (reset on each connect)
	private currentMetrics: LoadTestMetrics = this.createEmptyMetrics();
	private startTime: number = 0;

	private createEmptyMetrics(): LoadTestMetrics {
		return {
			timestamp: Date.now(),
			elapsed_seconds: 0,
			requests_completed: 0,
			requests_failed: 0,
			current_rps: 0,
			current_concurrency: 0,
			latency_p50_ms: 0,
			latency_p95_ms: 0,
			latency_p99_ms: 0,
			avg_latency_ms: 0,
			bytes_sent: 0,
			bytes_received: 0,
			send_rate: 0,
			throughput: 0,
			backpressure: 0,
			dropped_requests: 0,
			avg_queue_wait_ms: 0,
			requests_sent: 0,
			requests_expected: 0,
		};
	}

	/**
	 * Attach to a run's live stream.
	 *
	 * One client for both run types, because there is one stream: a load run
	 * publishes `metrics` ticks and a scenario run publishes `step` events, on
	 * the same ring with the same monotonic ids, and both end with `complete`.
	 * `onStep`, `onMonitor` and `onPlan` are optional so a caller says nothing
	 * about the events it has no use for rather than passing handlers it will
	 * not read: a load run emits no steps and no plan, and only a run
	 * configured with a `monitor` block emits scrapes.
	 *
	 * One client for both run types also means this call *takes* the client
	 * from whoever held it, and `onSuperseded` is how that subscriber hears
	 * about it (issue #1417). It runs before the new stream is opened, so the
	 * displaced run has given up everything it held by the time the new one
	 * starts taking anything.
	 */
	connect(
		runId: string,
		onMessage: SSEMessageHandler,
		onError: SSEErrorHandler,
		onClose: SSECloseHandler,
		onStep?: SSEStepHandler,
		onMonitor?: SSEMonitorHandler,
		onPlan?: SSEPlanHandler,
		onSuperseded?: SSESupersededHandler
	): void {
		// Close whatever is attached, and tell its owner it was displaced -
		// which `disconnect()` deliberately does not do, because a subscriber
		// that hangs up on itself is not superseded by anyone.
		this.supersede();

		// Reset metrics state for new connection
		this.currentMetrics = this.createEmptyMetrics();
		this.startTime = 0;

		const endpoint = API_ENDPOINTS.METRICS_LIVE(runId);
		const url = `${API_ENDPOINTS.BASE_URL}${endpoint}`;

		try {
			this.eventSource = new EventSource(url);
			// Recorded only once there is a stream to be displaced from. A
			// caller whose connect threw is told by `onError` below and holds
			// nothing, so a later connect has nobody to supersede.
			this.onSuperseded = onSuperseded ?? null;

			// Handle metrics event - unified format from both endpoints
			this.eventSource.addEventListener("metrics", (event) => {
				try {
					// Both endpoints now send complete metrics object in same format
					const metrics = JSON.parse(event.data);

					// Initialize start time on first metrics
					if (this.startTime === 0 && metrics.timestamp) {
						this.startTime = metrics.timestamp;
					}

					// Map from backend camelCase format to frontend LoadTestMetrics
					this.currentMetrics = mapSseMetrics(metrics);

					onMessage({ ...this.currentMetrics });
				} catch (error) {
					console.error("Failed to parse metrics:", error);
				}
			});

			// A scenario run's per-step event. Registered only when a caller
			// asked for steps - a load run never emits one, so an unconditional
			// listener would be dead wiring on that path.
			if (onStep) {
				this.eventSource.addEventListener("step", (event) => {
					try {
						const step = parseStepEvent(JSON.parse(event.data));
						// A payload this client cannot read is dropped, not
						// rendered as a defaulted step - see parseStepEvent.
						if (step) onStep(step);
					} catch (error) {
						console.error("Failed to parse step:", error);
					}
				});
			}

			// The size a collection run resolved to, once, before its first
			// step (issue #1398). Registered on the same terms as the steps
			// it is the denominator for: a load run publishes no such frame.
			if (onPlan) {
				this.eventSource.addEventListener("plan", (event) => {
					try {
						const plan = parsePlanEvent(JSON.parse(event.data));
						if (plan) onPlan(plan);
					} catch (error) {
						console.error("Failed to parse plan:", error);
					}
				});
			}

			// Server vitals scraped alongside the run. Registered only when a
			// caller asked for them - a run without a monitor block never
			// emits one, so an unconditional listener would be dead wiring.
			if (onMonitor) {
				this.eventSource.addEventListener("monitor", (event) => {
					try {
						const sample = parseMonitorEvent(JSON.parse(event.data));
						if (sample) onMonitor(sample);
					} catch (error) {
						console.error("Failed to parse monitor sample:", error);
					}
				});
			}

			this.eventSource.addEventListener("complete", (event) => {
				// Send final metrics before closing
				onMessage({ ...this.currentMetrics });
				this.disconnect();
				// The frame says how the run ended, and this is the only place
				// that hears it: the stored report is fetched afterwards and a
				// dropped stream never gets one at all (#1415).
				onClose(parseTerminalStatus((event as MessageEvent).data));
			});

			this.eventSource.addEventListener("error", (_event) => {
				// If the connection is definitively closed, treat as terminal.
				// The engine now sends an explicit `complete` event for normal run end,
				// so a CLOSED error state means a genuine connection failure.
				//
				// NOTE: we intentionally do NOT reconnect here. Standard `EventSource`
				// has no API to set the `Last-Event-ID` header on a fresh connection,
				// so a manual reconnect would request `from=0` and the engine would
				// replay the entire retained topic - duplicating every tick already
				// shown and clobbering live RPS / throughput visuals. The browser's
				// own intra-connection retry (while in CONNECTING) does carry
				// Last-Event-ID and is fine; once the browser gives up (CLOSED), the
				// canonical recovery is to converge on `GET /runs/:id/report`, which
				// the load-test service does in its onClose handler.
				if (this.eventSource?.readyState === EventSource.CLOSED) {
					// A warn, not chatter: the stream ended without the engine's
					// `complete`, so the metrics shown are whatever arrived before
					// the drop and the caller is about to converge on the stored
					// report. That is the one SSE lifecycle state worth a line in
					// the console.
					console.warn("SSE connection closed unexpectedly - treating as terminal");
					this.disconnect();
					// No frame arrived, so nothing here knows how the run ended.
					onClose(null);
				}
				// For CONNECTING state errors, wait - the browser will retry.
			});
		} catch (error) {
			onError(error instanceof Error ? error : new Error("Failed to connect to SSE"));
		}
	}

	/**
	 * Close the stream. The subscriber is told nothing: every caller of this is
	 * either the subscriber itself hanging up (`stopMonitoring`) or a terminal
	 * frame this client is about to report through `onClose`.
	 */
	disconnect(): void {
		// Dropped with the socket it belongs to, so a later `connect` cannot
		// supersede a subscriber that already let go.
		this.onSuperseded = null;
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
	}

	/**
	 * Close the stream on behalf of a *new* subscriber, and tell the old one.
	 *
	 * The handler is cleared before it is invoked, not after: it fires once per
	 * displaced subscriber even if the handler itself reaches back into this
	 * client, and a subscriber that already hung up has none to fire.
	 */
	private supersede(): void {
		const displaced = this.onSuperseded;
		this.disconnect();
		displaced?.();
	}

	isConnected(): boolean {
		return this.eventSource?.readyState === EventSource.OPEN;
	}
}

// Export singleton instance
export const sseClient = new SSEClient();
