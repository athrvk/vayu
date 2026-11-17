/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { InFlightCalls, MAX_IN_FLIGHT_CALLS } from "./in-flight-calls.js";

/** A connection the test does not watch. */
const keep = () => {};

describe("InFlightCalls", () => {
	test("a cancel naming the session and the request aborts that call", () => {
		const calls = new InFlightCalls();
		const call = calls.track("s1", 7, keep);
		expect(calls.cancel("s1", 7)).toBe(true);
		expect(call.signal.aborted).toBe(true);
		expect(calls.size).toBe(0);
	});

	test("another session's request with the same id is left running", () => {
		const calls = new InFlightCalls();
		const mine = calls.track("s1", 7, keep);
		const theirs = calls.track("s2", 7, keep);
		expect(calls.size).toBe(2);
		expect(calls.cancel("unknown", 7)).toBe(false);
		expect(calls.cancel("s2", 7)).toBe(true);
		expect(theirs.signal.aborted).toBe(true);
		expect(mine.signal.aborted).toBe(false);
		expect(calls.cancel("s1", 7)).toBe(true);
		expect(mine.signal.aborted).toBe(true);
	});

	test("a string id and a number id are different requests", () => {
		const calls = new InFlightCalls();
		const numbered = calls.track("s1", 1, keep);
		const named = calls.track("s1", "1", keep);
		expect(calls.size).toBe(2);
		expect(calls.cancel("s1", "1")).toBe(true);
		expect(named.signal.aborted).toBe(true);
		expect(numbered.signal.aborted).toBe(false);
	});

	test("a released call is forgotten and no later cancel reaches it", () => {
		const calls = new InFlightCalls();
		const call = calls.track("s1", 7, keep);
		call.release();
		call.release();
		expect(calls.size).toBe(0);
		expect(calls.cancel("s1", 7)).toBe(false);
		expect(call.signal.aborted).toBe(false);
	});

	test("releasing a replaced call leaves the one that took its key", () => {
		const calls = new InFlightCalls();
		const first = calls.track("s1", 7, keep);
		const second = calls.track("s1", 7, keep);
		first.release();
		expect(calls.size).toBe(1);
		expect(calls.cancel("s1", 7)).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(first.signal.aborted).toBe(false);
	});

	test("past the cap the oldest call goes, unaborted", () => {
		const calls = new InFlightCalls(2);
		const oldest = calls.track("s1", 1, keep);
		calls.track("s1", 2, keep);
		calls.track("s1", 3, keep);
		expect(calls.size).toBe(2);
		expect(calls.cancel("s1", 1)).toBe(false);
		expect(oldest.signal.aborted).toBe(false);
		expect(calls.cancel("s1", 2)).toBe(true);
		expect(calls.cancel("s1", 3)).toBe(true);
	});

	test("a stop drops every call's connection before aborting it, and forgets them all", () => {
		const calls = new InFlightCalls();
		const events: string[] = [];
		const track = (sessionId: string, requestId: number) => {
			const call = calls.track(sessionId, requestId, () =>
				events.push(`drop ${sessionId}:${requestId} aborted=${call.signal.aborted}`)
			);
			return call;
		};
		const first = track("s1", 1);
		const second = track("s2", 1);
		const finished = track("s1", 2);
		finished.release();

		calls.abortAll();
		expect(events).toEqual(["drop s1:1 aborted=false", "drop s2:1 aborted=false"]);
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(finished.signal.aborted).toBe(false);
		expect(calls.size).toBe(0);
		expect(calls.cancel("s1", 1)).toBe(false);
	});

	test("a cancel aborts its call without dropping the connection", () => {
		const calls = new InFlightCalls();
		let dropped = false;
		const call = calls.track("s1", 7, () => (dropped = true));
		calls.cancel("s1", 7);
		expect(call.signal.aborted).toBe(true);
		expect(dropped).toBe(false);
	});

	test("the default bound holds however many calls arrive", () => {
		const calls = new InFlightCalls();
		for (let i = 0; i < MAX_IN_FLIGHT_CALLS * 4; i++) calls.track("s1", i, keep);
		expect(calls.size).toBe(MAX_IN_FLIGHT_CALLS);
	});
});
