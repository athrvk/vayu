/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both stream-event funnels carry the engine's error mark (issue #3996).
 *
 * A streamed event reaches the Events tab twice: live, through the relay's frame parser
 * (`parseMessageFrame`, which whitelists member by member), and stored, through the trace's
 * `events` node (`eventsFromTrace`, which passes the items through). A member the parser forgets
 * shows on the stored list and not the live one, and nothing else notices. This drives both with
 * the same wire event and asserts they agree; it is the shape of `validation-funnels.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { parseMessageFrame } from "../hooks/useExecutionEvents";
import { eventsFromTrace, responseFromRunResult, type RunResultSample } from "./restore-response";

/** One event as the engine writes it on the relay and in the stored node: the same object. */
const WIRE = {
	event: "message",
	data: '{"error":{"message":"Overloaded"}}',
	receivedAt: 1_750_000_000_000,
	isError: true,
};

const PLAIN = { event: "message", data: "hello", receivedAt: 1_750_000_000_001 };

const traceWith = (items: unknown[]): NonNullable<RunResultSample["trace"]> =>
	({
		request: { method: "GET", url: "https://api.example.com/stream", headers: {} },
		response: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
		events: {
			items,
			totalEvents: items.length,
			eventsTruncated: false,
			endReason: "completed",
		},
	}) as unknown as NonNullable<RunResultSample["trace"]>;

describe("the live funnel", () => {
	it("keeps the mark on the parsed frame", () => {
		expect(parseMessageFrame(WIRE)?.isError).toBe(true);
	});

	it("leaves the member absent on an unmarked frame", () => {
		expect(parseMessageFrame(PLAIN)).not.toHaveProperty("isError");
	});
});

describe("the stored funnel", () => {
	it("passes the mark through the trace's items", () => {
		expect(eventsFromTrace(traceWith([WIRE, PLAIN])).events).toEqual([WIRE, PLAIN]);
	});

	it("reaches the response the pane renders", () => {
		const sample = {
			timestamp: 1_700_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: traceWith([WIRE, PLAIN]),
		} as unknown as RunResultSample;
		expect(responseFromRunResult(sample)?.events?.map((e) => e.isError)).toEqual([
			true,
			undefined,
		]);
	});
});

describe("funnel parity", () => {
	it.each([
		["a marked event", WIRE],
		["an unmarked one", PLAIN],
	])("shows %s the same live and restored", (_name, wire) => {
		// Remove the `isError` member from `parseMessageFrame` and the marked case fails.
		const live = parseMessageFrame(wire);
		const restored = eventsFromTrace(traceWith([wire])).events?.[0];
		expect(live).toEqual(restored);
	});
});
