/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The relay frame parsers, and the reconnect backoff (issue #574).
 *
 * These are the parts of the events hook that can be wrong quietly. A parser
 * that defaults a missing field draws a row claiming an event the origin never
 * sent; a `complete` frame this build cannot read has to still *end* the
 * stream, or the pane says "streaming" forever after the socket closes.
 *
 * The backoff's first step has to clear the engine's stale-claim window, since
 * a reconnect inside it meets a `409` the browser treats as fatal.
 */

import { describe, it, expect } from "vitest";
import {
	EXECUTION_EVENTS_RETRY_BASE_MS,
	EXECUTION_EVENTS_RETRY_MAX_MS,
	executionEventsRetryDelayMs,
	parseCompleteFrame,
	parseMessageFrame,
	parseOpenFrame,
} from "./useExecutionEvents";

describe("parseMessageFrame", () => {
	it("takes a well-formed relayed event", () => {
		expect(
			parseMessageFrame({
				event: "token",
				data: "Hello",
				sourceId: "42",
				receivedAt: 1_750_000_000_000,
			})
		).toEqual({
			event: "token",
			data: "Hello",
			sourceId: "42",
			receivedAt: 1_750_000_000_000,
		});
	});

	it("keeps the in-band truncation disclosure", () => {
		const parsed = parseMessageFrame({
			event: "message",
			data: "abc",
			dataTruncated: true,
			dataBytes: 9000,
		});
		expect(parsed).toMatchObject({ dataTruncated: true, dataBytes: 9000 });
	});

	it("keeps an event whose data is genuinely empty", () => {
		// `""` is a payload the origin sent, not a missing one.
		expect(parseMessageFrame({ event: "ping", data: "" })).toEqual({
			event: "ping",
			data: "",
		});
	});

	it.each([
		["no event name", { data: "x" }],
		["no data", { event: "message" }],
		["a non-string data", { event: "message", data: 5 }],
		["not an object", "message"],
		["null", null],
	])("drops a frame with %s rather than defaulting it", (_label, raw) => {
		expect(parseMessageFrame(raw)).toBeNull();
	});

	it("drops an unreadable optional rather than carrying it through", () => {
		const parsed = parseMessageFrame({ event: "m", data: "d", sourceId: 7, receivedAt: "now" });
		expect(parsed).toEqual({ event: "m", data: "d" });
	});
});

describe("parseOpenFrame", () => {
	it("takes what the stream connected to", () => {
		expect(
			parseOpenFrame({
				statusCode: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream" },
			})
		).toEqual({
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": "text/event-stream" },
		});
	});

	it("drops a frame with no status - it would draw as a client error", () => {
		expect(parseOpenFrame({ statusText: "OK", headers: {} })).toBeNull();
	});

	it("defaults only the fields that are safe to default", () => {
		expect(parseOpenFrame({ statusCode: 204 })).toEqual({
			statusCode: 204,
			statusText: "",
			headers: {},
		});
	});
});

describe("parseCompleteFrame", () => {
	it("takes the reason and the engine's own total", () => {
		expect(parseCompleteFrame({ reason: "maxStreamEvents", totalEvents: 4000 })).toEqual({
			reason: "maxStreamEvents",
			totalEvents: 4000,
		});
	});

	it("reports a reason it cannot read as an error rather than inventing one", () => {
		// The tab says why every stream ended; "the engine said something I
		// could not read" is closer to an error than to a clean close.
		expect(parseCompleteFrame({ reason: "somethingNew" }).reason).toBe("error");
	});

	it("still ends the stream when the payload is unreadable entirely", () => {
		expect(parseCompleteFrame(null)).toEqual({ reason: "error", totalEvents: null });
	});
});

describe("executionEventsRetryDelayMs", () => {
	const noJitter = () => 0;

	it("doubles each attempt from the base step", () => {
		expect(executionEventsRetryDelayMs(1, noJitter)).toBe(EXECUTION_EVENTS_RETRY_BASE_MS);
		expect(executionEventsRetryDelayMs(2, noJitter)).toBe(EXECUTION_EVENTS_RETRY_BASE_MS * 2);
		expect(executionEventsRetryDelayMs(3, noJitter)).toBe(EXECUTION_EVENTS_RETRY_BASE_MS * 4);
	});

	it("caps the step", () => {
		expect(executionEventsRetryDelayMs(50, noJitter)).toBe(EXECUTION_EVENTS_RETRY_MAX_MS);
	});

	it("adds jitter above the step, never below it", () => {
		// Below the step would retry sooner than the claim window it exists to
		// clear; several watchers retrying in lockstep is what the jitter is for.
		const jittered = executionEventsRetryDelayMs(1, () => 1);
		expect(jittered).toBeGreaterThan(EXECUTION_EVENTS_RETRY_BASE_MS);
		expect(jittered).toBeLessThanOrEqual(EXECUTION_EVENTS_RETRY_BASE_MS * 1.5);
	});
});
