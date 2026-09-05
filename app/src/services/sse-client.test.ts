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
});

describe("parseStepEvent", () => {
	it("carries the data row when the run has one, and omits the key when it does not", () => {
		const base = {
			iteration: 1,
			stepIndex: 0,
			name: "Log in",
			outcome: "passed",
			statusCode: 200,
			latencyMs: 42.7,
		};

		expect(parseStepEvent({ ...base, dataRowIndex: 2 })?.dataRowIndex).toBe(2);
		// Absent, not 0 - a defaulted row index reads as "row 1 of a data file"
		// for a run that had none.
		expect(parseStepEvent(base)).not.toHaveProperty("dataRowIndex");
	});

	it("carries the request the step ran, and omits the key for an empty or missing id", () => {
		const base = {
			iteration: 1,
			stepIndex: 0,
			name: "Checkout",
			outcome: "failed",
			statusCode: 500,
			latencyMs: 12,
		};

		expect(parseStepEvent({ ...base, requestId: "req_checkout" })?.requestId).toBe(
			"req_checkout"
		);
		expect(parseStepEvent(base)).not.toHaveProperty("requestId");
		// An empty id is not a request: the step card keys its action off the
		// field's presence, so carrying "" would offer a link to nothing.
		expect(parseStepEvent({ ...base, requestId: "" })).not.toHaveProperty("requestId");
		expect(parseStepEvent({ ...base, requestId: 7 })).not.toHaveProperty("requestId");
	});

	it("carries the schema verdict when the collection is bound, and no key when it is not", () => {
		const base = {
			iteration: 0,
			stepIndex: 0,
			name: "Get pet",
			outcome: "passed",
			statusCode: 200,
			latencyMs: 12,
		};

		const verdict = { checked: true, valid: false, failuresTotal: 1 };
		expect(parseStepEvent({ ...base, validation: verdict })?.validation).toEqual(verdict);
		// Absent stays absent: an unbound collection produces no verdict, and an
		// empty one here would render as "checked, and fine".
		expect(parseStepEvent(base)).not.toHaveProperty("validation");
		// A malformed node is not a verdict either.
		expect(parseStepEvent({ ...base, validation: "nope" })).not.toHaveProperty("validation");
	});

	it("carries the assertion tally when the step made any, and no key when it did not", () => {
		const base = {
			iteration: 0,
			stepIndex: 0,
			name: "Get pet",
			outcome: "failed",
			statusCode: 200,
			latencyMs: 12,
		};

		expect(parseStepEvent({ ...base, tests: { passed: 2, failed: 1 } })?.tests).toEqual({
			passed: 2,
			failed: 1,
		});
		// Absent stays absent: a step whose script asserted nothing has no
		// tally, and `0 passed` would read as a result rather than as silence.
		expect(parseStepEvent(base)).not.toHaveProperty("tests");
		// Half a tally is not a tally - the chip would render `NaN passed`.
		expect(parseStepEvent({ ...base, tests: { passed: 2 } })).not.toHaveProperty("tests");
		expect(parseStepEvent({ ...base, tests: "nope" })).not.toHaveProperty("tests");
	});

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
		expect(parseTerminalStatus('{"status":"Completed"}')).toBe("Completed");
		expect(parseTerminalStatus('{"status":"Stopped"}')).toBe("Stopped");
		expect(parseTerminalStatus('{"status":"Failed"}')).toBe("Failed");
	});

	/*
	 * Null is "ask the report", never "it finished" - which is the distinction
	 * the whole fix turns on. Mutation check: default an unparseable frame to
	 * "Completed" and a failed run whose frame was malformed reports success.
	 */
	it("answers null for a frame that carries no status it knows", () => {
		for (const raw of [
			'{"event":"complete","runId":"r1"}',
			'{"status":"Running"}',
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
		MockEventSource.instances[0]?.complete("Completed");
		expect(first.onClose).toHaveBeenCalledWith("Completed");

		attach(client, "run_2", handlers());
		expect(first.onSuperseded).not.toHaveBeenCalled();
	});

	it("accepts a subscriber that passes no supersede handler at all", () => {
		const client = new SSEClient();
		client.connect("run_1", vi.fn(), vi.fn(), vi.fn());
		expect(() => client.connect("run_2", vi.fn(), vi.fn(), vi.fn())).not.toThrow();
	});
});
