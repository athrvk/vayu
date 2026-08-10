/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { mapSseMetrics, parseMonitorEvent, parseStepEvent } from "./sse-client";

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
