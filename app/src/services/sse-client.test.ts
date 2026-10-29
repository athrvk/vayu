/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	mapSseMetrics,
	parseMonitorEvent,
	parsePlanEvent,
	parseStepEvent,
	parseTerminalStatus,
	SSEClient,
} from "./sse-client";

describe("mapSseMetrics", () => {
	it("maps bytes and the full status-code map", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			elapsedSeconds: 1,
			totalRequests: 2,
			bytesSent: 50,
			bytesReceived: 500,
			statusCodes: { "200": 1, "404": 1 },
		});
		expect(m.bytes_sent).toBe(50);
		expect(m.bytes_received).toBe(500);
		expect(m.status_codes).toEqual({ "200": 1, "404": 1 });
	});

	it("defaults bytes to 0 and leaves status_codes undefined when absent", () => {
		const m = mapSseMetrics({ timestamp: 1, totalRequests: 0 });
		expect(m.bytes_sent).toBe(0);
		expect(m.bytes_received).toBe(0);
		expect(m.status_codes).toBeUndefined();
	});

	it("marks a frame as live and leaves the second and cumulative percentiles absent (issue #2385)", () => {
		const m = mapSseMetrics({ timestamp: 1, latencyP99Ms: 12 });
		expect(m.live).toBe(true);
		expect(m.latency_p99_ms).toBe(12);
		// An absent key is "not a gate frame", never a measured 0 ms.
		expect(m.second_samples).toBeUndefined();
		expect(m.second_p50_ms).toBeUndefined();
		expect(m.second_p95_ms).toBeUndefined();
		expect(m.second_p99_ms).toBeUndefined();
		expect(m.cumulative_p50_ms).toBeUndefined();
		expect(m.cumulative_p95_ms).toBeUndefined();
		expect(m.cumulative_p99_ms).toBeUndefined();
	});

	it("maps a gate frame's second_* and the cumulative percentiles (issue #2385)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			secondSamples: 840,
			secondP50Ms: 10,
			secondP95Ms: 20,
			secondP99Ms: 300,
			cumulativeP50Ms: 11,
			cumulativeP95Ms: 22,
			cumulativeP99Ms: 330,
		});
		expect(m.second_samples).toBe(840);
		expect([m.second_p50_ms, m.second_p95_ms, m.second_p99_ms]).toEqual([10, 20, 300]);
		expect([m.cumulative_p50_ms, m.cumulative_p95_ms, m.cumulative_p99_ms]).toEqual([
			11, 22, 330,
		]);
	});

	it("maps a scenario load gate frame's sequence block as sent (issue #2823)", () => {
		const scenario = {
			iterations: 12,
			iterationsCompleted: 9,
			iterationsAbandoned: 1,
			stepsExecuted: 30,
			steps: [
				{ index: 0, name: "Log in", executed: 12, errors: 0 },
				{ index: 1, name: "List orders", executed: 10, errors: 2 },
			],
		};
		expect(mapSseMetrics({ timestamp: 1, scenario }).scenario).toEqual(scenario);
	});

	it("leaves the sequence block absent on a frame without one (issue #2823)", () => {
		// Absent is "not a gate frame" or "not a scenario load"; a zeroed block
		// would draw a sequence panel for a run that has none.
		expect(mapSseMetrics({ timestamp: 1, totalRequests: 5 }).scenario).toBeUndefined();
	});

	it("keeps a null second and a null cumulative as null, not 0 (issue #2385)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			secondSamples: 0,
			secondP50Ms: null,
			secondP95Ms: null,
			secondP99Ms: null,
			cumulativeP50Ms: null,
			cumulativeP95Ms: null,
			cumulativeP99Ms: null,
		});
		expect(m.second_samples).toBe(0);
		expect(m.second_p99_ms).toBeNull();
		expect(m.cumulative_p99_ms).toBeNull();
	});

	/* Mutation check: drop `status_seconds` from the mapper and the first two reden. */
	describe("the gate frame's per-second status counts (issue #2866)", () => {
		it("maps statusSeconds to status_seconds, entries as sent", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				statusSeconds: [
					{ second: 0, span: 1, counts: [50, 0, 0, 0, 0] },
					{ second: 1, span: 1, counts: [40, 0, 2, 7, 1] },
				],
			});
			expect(m.status_seconds).toEqual([
				{ second: 0, span: 1, counts: [50, 0, 0, 0, 0] },
				{ second: 1, span: 1, counts: [40, 0, 2, 7, 1] },
			]);
		});

		it("keeps a gate that closed no second as [], not as absent", () => {
			expect(mapSseMetrics({ timestamp: 1, statusSeconds: [] }).status_seconds).toEqual([]);
		});

		it("leaves a frame between gates without the key", () => {
			expect(
				mapSseMetrics({ timestamp: 1, totalRequests: 3 }).status_seconds
			).toBeUndefined();
		});
	});

	/* Mutation check: drop `capacity` from the mapper and the first three redden. */
	describe("a capacity run's search state (issue #2928)", () => {
		it("maps capacity as sent while the search runs, with no stopReason", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				capacity: { level: 16, levelElapsedMs: 3000, levelsJudged: 2 },
			});
			expect(m.capacity).toEqual({ level: 16, levelElapsedMs: 3000, levelsJudged: 2 });
			expect(m.capacity).not.toHaveProperty("stopReason");
		});

		it("maps the stopReason the final frame carries", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				capacity: {
					level: 64,
					levelElapsedMs: 5000,
					levelsJudged: 4,
					stopReason: "stopped",
				},
			});
			expect(m.capacity).toEqual({
				level: 64,
				levelElapsedMs: 5000,
				levelsJudged: 4,
				stopReason: "stopped",
			});
		});

		it("keeps level 0 before the first level opens, not as absent", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				capacity: { level: 0, levelElapsedMs: 0, levelsJudged: 0 },
			});
			expect(m.capacity).toEqual({ level: 0, levelElapsedMs: 0, levelsJudged: 0 });
		});

		it("leaves a frame of any other run without the key", () => {
			expect(mapSseMetrics({ timestamp: 1, totalRequests: 3 }).capacity).toBeUndefined();
		});
	});

	describe("the gate frame's run-so-far distributions (issue #2782)", () => {
		const latency = {
			minMs: 1,
			p50Ms: 5,
			p75Ms: 8,
			p90Ms: 12,
			p95Ms: 20,
			p99Ms: 40,
			p999Ms: 90,
			maxMs: 120,
			count: 600,
		};
		const phase = { meanMs: 0.5, p50Ms: 0.4, p95Ms: 1, p99Ms: 2, maxMs: 7, count: 600 };
		const phases = {
			dns: phase,
			connect: phase,
			tls: phase,
			firstByte: { ...phase, meanMs: 3.1 },
			download: phase,
		};

		it("passes both objects through as sent", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				cumulativeLatency: latency,
				cumulativePhases: phases,
			});
			expect(m.cumulative_latency).toEqual(latency);
			expect(m.cumulative_phases).toEqual(phases);
		});

		it("keeps a null as null: nothing has completed yet, not a measured zero", () => {
			const m = mapSseMetrics({
				timestamp: 1,
				cumulativeLatency: null,
				cumulativePhases: null,
			});
			expect(m.cumulative_latency).toBeNull();
			expect(m.cumulative_phases).toBeNull();
		});

		it("keeps an absent key undefined: not a gate frame, or the phase histograms are off", () => {
			const off = mapSseMetrics({ timestamp: 1, cumulativeLatency: latency });
			expect(off.cumulative_latency).toEqual(latency);
			expect(off.cumulative_phases).toBeUndefined();

			const between = mapSseMetrics({ timestamp: 1 });
			expect(between.cumulative_latency).toBeUndefined();
			expect(between.cumulative_phases).toBeUndefined();
		});
	});

	it("keeps a window with no completion as null percentiles, not 0 ms (issue #2386)", () => {
		// As the engine sends it, `latencySamples` included, which the app does not read.
		const frame = {
			timestamp: 1,
			totalRequests: 40,
			latencySamples: 0,
			latencyP50Ms: null,
			latencyP95Ms: null,
			latencyP99Ms: null,
		};
		const m = mapSseMetrics(frame);
		expect(m.requests_completed).toBe(40);
		expect(m.latency_p50_ms).toBeNull();
		expect(m.latency_p95_ms).toBeNull();
		expect(m.latency_p99_ms).toBeNull();
	});

	it("still maps a populated window's percentiles, a 0 ms one included", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			latencyP50Ms: 0,
			latencyP95Ms: 9.5,
			latencyP99Ms: 41,
		});
		expect([m.latency_p50_ms, m.latency_p95_ms, m.latency_p99_ms]).toEqual([0, 9.5, 41]);
	});

	it("maps the trailing window's send rate and means (issue #2393)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			currentRps: 480,
			currentSendRate: 500,
			windowAvgLatencyMs: 12.5,
			windowAvgQueueWaitMs: 0,
		});
		expect(m.current_rps).toBe(480);
		expect(m.current_send_rate).toBe(500);
		expect(m.window_avg_latency_ms).toBe(12.5);
		// A measured zero stays a zero.
		expect(m.window_avg_queue_wait_ms).toBe(0);
	});

	it("leaves the window's keys absent when the frame has none, never 0 (issue #2393)", () => {
		const m = mapSseMetrics({ timestamp: 1, currentRps: 480 });
		expect(m.current_send_rate).toBeUndefined();
		expect(m.window_avg_latency_ms).toBeUndefined();
		expect(m.window_avg_queue_wait_ms).toBeUndefined();
	});

	it("keeps an idle window's null means as null, not 0 (issue #2393)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			currentRps: 0,
			currentSendRate: 0,
			windowAvgLatencyMs: null,
			windowAvgQueueWaitMs: null,
		});
		expect(m.current_send_rate).toBe(0);
		expect(m.window_avg_latency_ms).toBeNull();
		expect(m.window_avg_queue_wait_ms).toBeNull();
	});

	it("maps the window's mean requests in flight as sent (issue #2821)", () => {
		expect(mapSseMetrics({ timestamp: 1, windowAvgInFlight: 4.2 }).window_avg_in_flight).toBe(
			4.2
		);
		// An idle window's measured 0 stays a 0, and a null stays null.
		expect(mapSseMetrics({ timestamp: 1, windowAvgInFlight: 0 }).window_avg_in_flight).toBe(0);
		expect(
			mapSseMetrics({ timestamp: 1, windowAvgInFlight: null }).window_avg_in_flight
		).toBeNull();
	});

	it("leaves the mean in flight absent for a frame without it, never 0 (issue #2821)", () => {
		const m = mapSseMetrics({ timestamp: 1, activeConnections: 10 });
		expect(m.window_avg_in_flight).toBeUndefined();
		expect(m.current_concurrency).toBe(10);
	});

	it("maps the error count and its HTTP errors / No response split (issue #2124)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			totalRequests: 100,
			totalErrors: 17,
			httpErrors: 15,
			noResponse: 2,
		});
		expect(m.requests_failed).toBe(17);
		expect(m.http_errors).toBe(15);
		expect(m.no_response).toBe(2);
	});

	it("defaults the error split to 0 when the frame carries none", () => {
		const m = mapSseMetrics({ timestamp: 1, totalRequests: 0 });
		expect(m.requests_failed).toBe(0);
		expect(m.http_errors).toBe(0);
		expect(m.no_response).toBe(0);
	});

	it("renames the skipped-request keys, and reads a frame without them as none (issue #2911)", () => {
		const m = mapSseMetrics({ timestamp: 1, skippedRequests: 30, stalledMs: 150 });
		expect(m.skipped_requests).toBe(30);
		expect(m.stalled_ms).toBe(150);

		const older = mapSseMetrics({ timestamp: 1, totalRequests: 0 });
		expect(older.skipped_requests).toBe(0);
		expect(older.stalled_ms).toBe(0);
	});

	it("renames customMetrics into custom_metrics (issue #1500)", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			customMetrics: { ttfb2: { type: "trend", count: 1, p95: 10 } },
		});
		expect(m.custom_metrics).toEqual({ ttfb2: { type: "trend", count: 1, p95: 10 } });
	});

	it("leaves custom_metrics undefined when absent", () => {
		const m = mapSseMetrics({ timestamp: 1, totalRequests: 0 });
		expect(m.custom_metrics).toBeUndefined();
	});
});

describe("parseStepEvent", () => {
	/*
	 * Each optional field of a step frame follows one rule: carried when the
	 * frame has a well-formed value, and the key left absent - never defaulted -
	 * when the value is missing or malformed.
	 */
	it.each([
		// Absent, not 0 - a defaulted row index reads as "row 1 of a data file"
		// for a run that had none.
		{ field: "dataRowIndex", value: 2, malformed: ["2"] },
		// An empty id is not a request: the step card keys its action off the
		// field's presence, so carrying "" would offer a link to nothing.
		{ field: "requestId", value: "req_checkout", malformed: ["", 7] },
		// An unbound collection produces no verdict, and an empty one here would
		// render as "checked, and fine". A malformed node is not a verdict either.
		{
			field: "validation",
			value: { checked: true, valid: false, failuresTotal: 1 },
			malformed: ["nope"],
		},
		// A step whose script asserted nothing has no tally, and `0 passed` would
		// read as a result rather than as silence. Half a tally is not a tally -
		// the chip would render `NaN passed`.
		{ field: "tests", value: { passed: 2, failed: 1 }, malformed: [{ passed: 2 }, "nope"] },
		// The engine sends it only on the step whose error ended its iteration
		// (issue #2526), so a 0 or a negative is no claim to render.
		{ field: "stepsNotRun", value: 3, malformed: ["3", 0, -1] },
		// Absent at 0 from the engine (issue #3053), so 0 is no claim either.
		{ field: "extractorMisses", value: 2, malformed: ["2", 0, -1] },
	])(
		"carries $field when present, and omits the key when absent or malformed",
		({ field, value, malformed }) => {
			const base = {
				iteration: 1,
				stepIndex: 0,
				name: "Log in",
				outcome: "passed",
				statusCode: 200,
				latencyMs: 42.7,
			};

			expect(parseStepEvent({ ...base, [field]: value })).toHaveProperty(field, value);
			expect(parseStepEvent(base)).not.toHaveProperty(field);
			for (const bad of malformed) {
				expect(parseStepEvent({ ...base, [field]: bad })).not.toHaveProperty(field);
			}
		}
	);

	it("reads a scenario run's step event", () => {
		expect(
			parseStepEvent({
				iteration: 1,
				stepIndex: 0,
				name: "Log in",
				outcome: "passed",
				statusCode: 200,
				latencyMs: 42.7,
			})
		).toEqual({
			iteration: 1,
			stepIndex: 0,
			name: "Log in",
			outcome: "passed",
			statusCode: 200,
			latencyMs: 42.7,
		});
	});

	it("accepts each of the four outcomes", () => {
		for (const outcome of ["passed", "failed", "skipped", "errored"]) {
			const step = parseStepEvent({ iteration: 0, stepIndex: 0, outcome });
			expect(step?.outcome).toBe(outcome);
		}
	});

	/*
	 * The rejections below all exist for one reason: the step list keys on
	 * `(iteration, stepIndex)`. A payload defaulted to `0:0` would not merely be
	 * a row saying nothing - it would collide with the real first step's row.
	 */
	it("rejects a payload with no step identity", () => {
		expect(parseStepEvent({ outcome: "passed" })).toBeNull();
		expect(parseStepEvent({ iteration: 0, outcome: "passed" })).toBeNull();
		expect(parseStepEvent({ stepIndex: 0, outcome: "passed" })).toBeNull();
	});

	it("rejects an identity that is not numeric", () => {
		expect(parseStepEvent({ iteration: "0", stepIndex: 0, outcome: "passed" })).toBeNull();
	});

	it("rejects an outcome outside the four", () => {
		expect(parseStepEvent({ iteration: 0, stepIndex: 0, outcome: "unknown" })).toBeNull();
		expect(parseStepEvent({ iteration: 0, stepIndex: 0 })).toBeNull();
	});

	it("rejects a non-object payload", () => {
		expect(parseStepEvent(null)).toBeNull();
		expect(parseStepEvent("step")).toBeNull();
	});

	it("names an unnamed step by its position rather than leaving it blank", () => {
		const step = parseStepEvent({ iteration: 0, stepIndex: 3, outcome: "passed" });
		expect(step?.name).toBe("Step 4");
		// A missing status code is "never reached a server", which is what 0
		// means everywhere else in the app.
		expect(step?.statusCode).toBe(0);
		expect(step?.latencyMs).toBe(0);
	});
});

describe("parseMonitorEvent", () => {
	it("reads a scrape", () => {
		expect(parseMonitorEvent({ timestamp: 1700, series: { cpu: 0.5, rss: 1024 } })).toEqual({
			timestamp: 1700,
			series: { cpu: 0.5, rss: 1024 },
		});
	});

	it("drops a frame with no usable timestamp or series", () => {
		// A sample defaulted to timestamp 0 would join onto the very start of the
		// run's timeline and draw a reading at a moment it was never taken.
		expect(parseMonitorEvent({ series: { cpu: 1 } })).toBeNull();
		expect(parseMonitorEvent({ timestamp: "1700", series: { cpu: 1 } })).toBeNull();
		expect(parseMonitorEvent({ timestamp: 1700 })).toBeNull();
		expect(parseMonitorEvent({ timestamp: 1700, series: {} })).toBeNull();
		expect(parseMonitorEvent(null)).toBeNull();
	});

	it("drops non-numeric readings but keeps the rest of the scrape", () => {
		expect(
			parseMonitorEvent({
				timestamp: 1700,
				series: { cpu: 0.5, name: "web-1", broken: Number.NaN },
			})
		).toEqual({ timestamp: 1700, series: { cpu: 0.5 } });
	});
});

describe("parsePlanEvent", () => {
	it("reads the size the run resolved", () => {
		expect(parsePlanEvent({ stepsPerIteration: 4, iterations: 3, stepsExpected: 12 })).toEqual({
			stepsPerIteration: 4,
			iterations: 3,
			stepsExpected: 12,
		});
	});

	it("drops a frame missing any of the three numbers", () => {
		// This frame is a denominator: a field defaulted to 0 would make every
		// fraction drawn from it either a division by zero or a bar that is full
		// from the first step. Rejecting it leaves the run indeterminate, which
		// is what a client that was told nothing should show.
		expect(parsePlanEvent({ iterations: 3, stepsExpected: 12 })).toBeNull();
		expect(parsePlanEvent({ stepsPerIteration: 4, stepsExpected: 12 })).toBeNull();
		expect(parsePlanEvent({ stepsPerIteration: 4, iterations: 3 })).toBeNull();
		expect(
			parsePlanEvent({ stepsPerIteration: "4", iterations: 3, stepsExpected: 12 })
		).toBeNull();
		expect(parsePlanEvent(null)).toBeNull();
	});
});

describe("parseTerminalStatus", () => {
	/*
	 * The frame is the only place a client hears how a run ended while the run
	 * is ending (#1415): the stored report is fetched afterwards, and a dropped
	 * stream never produces one at all.
	 */
	it("reads the three statuses the engine emits", () => {
		expect(parseTerminalStatus('{"status":"completed"}')).toBe("completed");
		expect(parseTerminalStatus('{"status":"stopped"}')).toBe("stopped");
		expect(parseTerminalStatus('{"status":"failed"}')).toBe("failed");
	});

	/*
	 * Null is "ask the report", never "it finished" - which is the distinction
	 * the whole fix turns on. Mutation check: default an unparseable frame to
	 * "completed" and a failed run whose frame was malformed reports success.
	 */
	it("answers null for a frame that carries no status it knows", () => {
		for (const raw of [
			'{"event":"complete","runId":"r1"}',
			'{"status":"running"}',
			'{"status":42}',
			"not json",
			"",
		]) {
			expect(parseTerminalStatus(raw), JSON.stringify(raw)).toBeNull();
		}
	});
});

/**
 * Who is told when a second run takes the client (issue #1417).
 *
 * The class itself rather than a service, because this is the rule the two run
 * services now share: `connect` displaces whoever held the socket, and only a
 * displacement invokes `onSuperseded`. A subscriber that hangs up on itself,
 * or whose run ended, is not superseded by the next run to start - and calling
 * it there would run a terminal path twice.
 */
class MockEventSource {
	static instances: MockEventSource[] = [];
	static CLOSED = 2;
	readyState = 1;
	listeners = new Map<string, (event: MessageEvent) => void>();
	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}
	addEventListener(type: string, fn: (event: MessageEvent) => void): void {
		this.listeners.set(type, fn);
	}
	close(): void {
		this.readyState = MockEventSource.CLOSED;
	}
	/** Deliver the engine's terminal frame, the way a finished run does. */
	complete(status: string): void {
		this.listeners.get("complete")?.({ data: JSON.stringify({ status }) } as MessageEvent);
	}
	/** The frame the engine's 60 s timeout sends: ended, with no word on how. */
	completeWithoutStatus(): void {
		this.listeners.get("complete")?.({ data: JSON.stringify({ runId: "r1" }) } as MessageEvent);
	}
	/** The browser giving up on the connection: an `error` in the CLOSED state. */
	drop(): void {
		this.readyState = MockEventSource.CLOSED;
		this.listeners.get("error")?.({} as MessageEvent);
	}
}

/** The four lifecycle handlers, named so a case can assert on one of them. */
function handlers() {
	return { onMessage: vi.fn(), onError: vi.fn(), onClose: vi.fn(), onSuperseded: vi.fn() };
}

function attach(client: SSEClient, runId: string, h: ReturnType<typeof handlers>): void {
	client.connect(
		runId,
		h.onMessage,
		h.onError,
		h.onClose,
		undefined,
		undefined,
		undefined,
		h.onSuperseded
	);
}

describe("SSEClient - the placeholder before the first tick", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		vi.stubGlobal("EventSource", MockEventSource);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports zero errors, with the split, when the run ends before any tick", () => {
		const client = new SSEClient();
		const h = handlers();

		attach(client, "run_1", h);
		MockEventSource.instances[0]?.complete("completed");

		expect(h.onMessage).toHaveBeenCalledTimes(1);
		expect(h.onMessage.mock.calls[0][0]).toMatchObject({
			requests_failed: 0,
			http_errors: 0,
			no_response: 0,
		});
	});
});

describe("SSEClient - the hand-off when a run is displaced", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		vi.stubGlobal("EventSource", MockEventSource);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/*
	 * Mutation check: drop the `supersede()` call at the top of `connect` (the
	 * bare `disconnect()` this replaced) and the first expectation reddens -
	 * which is exactly the bug, a socket closed with nobody told.
	 */
	it("tells the displaced subscriber once, and never through onClose", () => {
		const client = new SSEClient();
		const first = handlers();
		const second = handlers();

		attach(client, "run_1", first);
		attach(client, "run_2", second);

		expect(first.onSuperseded).toHaveBeenCalledTimes(1);
		// A close means the run ended and the report is worth fetching. A
		// takeover means neither, so the two must not share a handler.
		expect(first.onClose).not.toHaveBeenCalled();
		expect(first.onError).not.toHaveBeenCalled();
		// The new subscriber holds the client; nothing has displaced it.
		expect(second.onSuperseded).not.toHaveBeenCalled();
		expect(MockEventSource.instances[0]?.readyState).toBe(MockEventSource.CLOSED);
	});

	it("displaces before the new stream is opened", () => {
		const client = new SSEClient();
		const first = handlers();
		/** How many sockets existed when the displaced subscriber was told. */
		let socketsAtHandOff = -1;
		first.onSuperseded.mockImplementation(() => {
			socketsAtHandOff = MockEventSource.instances.length;
		});

		attach(client, "run_1", first);
		attach(client, "run_2", handlers());

		// One: the run being displaced. The replacement is opened afterwards, so
		// the displaced service can give up its claims without the new run's
		// having been taken yet.
		expect(socketsAtHandOff).toBe(1);
	});

	it("supersedes nobody after a subscriber disconnects itself", () => {
		const client = new SSEClient();
		const first = handlers();

		attach(client, "run_1", first);
		client.disconnect();
		attach(client, "run_2", handlers());

		expect(first.onSuperseded).not.toHaveBeenCalled();
	});

	/*
	 * The run ended on its own, so its terminal path already ran. Mutation
	 * check: stop clearing the handler in `disconnect` and this reddens, with a
	 * finished run being told it was superseded by the next one to start.
	 */
	it("supersedes nobody after the stream ended with the engine's frame", () => {
		const client = new SSEClient();
		const first = handlers();

		attach(client, "run_1", first);
		MockEventSource.instances[0]?.complete("completed");
		expect(first.onClose).toHaveBeenCalledWith("completed", { frame: true });

		attach(client, "run_2", handlers());
		expect(first.onSuperseded).not.toHaveBeenCalled();
	});

	it("accepts a subscriber that passes no supersede handler at all", () => {
		const client = new SSEClient();
		client.connect("run_1", vi.fn(), vi.fn(), vi.fn());
		expect(() => client.connect("run_2", vi.fn(), vi.fn(), vi.fn())).not.toThrow();
	});
});

describe("SSEClient - what the close handler is told (#2140)", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		vi.stubGlobal("EventSource", MockEventSource);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/*
	 * Mutation check: collapse the three endings into `onClose(null)` and the
	 * bare-frame and dropped-connection cases below can no longer be told apart,
	 * so the first of them reddens.
	 */
	it("reports a status frame as a frame, with its status", () => {
		const h = handlers();
		attach(new SSEClient(), "run_1", h);

		MockEventSource.instances[0]?.complete("failed");

		expect(h.onClose).toHaveBeenCalledExactlyOnceWith("failed", { frame: true });
	});

	it("reports a frame with no status as a frame, with a null status", () => {
		const h = handlers();
		attach(new SSEClient(), "run_1", h);

		MockEventSource.instances[0]?.completeWithoutStatus();

		expect(h.onClose).toHaveBeenCalledExactlyOnceWith(null, { frame: true });
	});

	it("reports a closed connection as no frame", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = handlers();
		attach(new SSEClient(), "run_1", h);

		MockEventSource.instances[0]?.drop();

		expect(h.onClose).toHaveBeenCalledExactlyOnceWith(null, { frame: false });
	});

	it("says nothing for an error the browser is still retrying", () => {
		const h = handlers();
		attach(new SSEClient(), "run_1", h);

		MockEventSource.instances[0]?.listeners.get("error")?.({} as MessageEvent);

		expect(h.onClose).not.toHaveBeenCalled();
	});
});
