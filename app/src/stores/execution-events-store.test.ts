/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The live half of a streaming request (issue #574).
 *
 * The store's one real rule is that every write is addressed to a run, and a
 * write for a run it is not holding is dropped. That is not defensive tidiness:
 * the relay replays its retained ring on connect, so a frame from a stream that
 * has already been replaced can still arrive on a socket that has not finished
 * closing. Without the guard those rows would land under the send that replaced
 * it, which is the worst possible failure here - a timeline that looks real and
 * belongs to something else.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useExecutionEventsStore } from "./execution-events-store";
import type { LeftOutElement } from "@/lib/elements";
import type { ExampleSentRequest, StreamEvent } from "@/types";

const event = (data: string): StreamEvent => ({ event: "message", data });

const sentTo = (url: string): ExampleSentRequest => ({
	method: "GET",
	url,
	params: [],
	headers: [],
	body: { mode: "none" },
});

const LEFT_OUT: LeftOutElement[] = [
	{
		element: { id: "el_1", kind: "assert.status", enabled: true, config: {} },
		needs: { missing: ["accepted codes or a range"], invalid: {} },
	},
];

const start = (runId: string, requestId = "req_1") =>
	useExecutionEventsStore.getState().startStream({
		requestId,
		runId,
		eventsUrl: `/runs/${runId}/events`,
	});

describe("execution events store", () => {
	beforeEach(() => useExecutionEventsStore.getState().clear());

	it("starts empty", () => {
		const s = useExecutionEventsStore.getState();
		expect(s.runId).toBeNull();
		expect(s.requestId).toBeNull();
		expect(s.events).toEqual([]);
		expect(s.isStreaming).toBe(false);
	});

	it("records the run, the request and the events URL the engine named", () => {
		start("run_1");
		const s = useExecutionEventsStore.getState();
		expect(s).toMatchObject({
			runId: "run_1",
			requestId: "req_1",
			eventsUrl: "/runs/run_1/events",
			isStreaming: true,
		});
	});

	it("appends events in arrival order", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvents("run_1", [event("a")]);
		useExecutionEventsStore.getState().addEvents("run_1", [event("b")]);

		expect(useExecutionEventsStore.getState().events.map((e) => e.data)).toEqual(["a", "b"]);
	});

	it("appends a batch in order, and holds the list's identity when nothing arrives", () => {
		// Issue #1158: the writer is a flush window's worth of frames, not one
		// frame. Order within the batch is arrival order, and a batch for another
		// run must not disturb the identity of the array on screen - the response
		// pane subscribes to it, so a fresh array is a re-render.
		start("run_1");
		useExecutionEventsStore.getState().addEvents("run_1", [event("a"), event("b")]);
		const afterFirst = useExecutionEventsStore.getState().events;

		useExecutionEventsStore.getState().addEvents("run_1", [event("c"), event("d")]);
		const afterSecond = useExecutionEventsStore.getState().events;

		expect(afterSecond.map((e) => e.data)).toEqual(["a", "b", "c", "d"]);
		expect(afterSecond).not.toBe(afterFirst);

		useExecutionEventsStore.getState().addEvents("run_2", [event("someone else's")]);
		expect(useExecutionEventsStore.getState().events).toBe(afterSecond);
	});

	it("drops an event addressed to a run it is not holding", () => {
		start("run_2");
		useExecutionEventsStore.getState().addEvents("run_1", [event("from the old socket")]);

		expect(useExecutionEventsStore.getState().events).toEqual([]);
	});

	it("drops an open frame and an end addressed to another run", () => {
		start("run_2");
		useExecutionEventsStore
			.getState()
			.noteOpen("run_1", { statusCode: 500, statusText: "Nope", headers: {} });
		useExecutionEventsStore.getState().endStream("run_1", "completed", 9);

		const s = useExecutionEventsStore.getState();
		expect(s.open).toBeNull();
		expect(s.isStreaming).toBe(true);
		expect(s.endReason).toBeNull();
	});

	it("starting a stream clears the previous one's rows", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvents("run_1", [event("a")]);
		useExecutionEventsStore.getState().endStream("run_1", "completed", 1);

		start("run_2");
		const s = useExecutionEventsStore.getState();
		expect(s.events).toEqual([]);
		expect(s.endReason).toBeNull();
		expect(s.totalEvents).toBeNull();
		expect(s.error).toBeNull();
	});

	it("holds the elements the Send left out for the stream's response, and forgets them with it (#3066)", () => {
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
			leftOut: LEFT_OUT,
		});
		expect(useExecutionEventsStore.getState().leftOut).toEqual(LEFT_OUT);

		// The next stream is another Send, with its own payload.
		start("run_2");
		expect(useExecutionEventsStore.getState().leftOut).toEqual([]);
	});

	it("keeps the engine's own total, which is not the row count once capped", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvents("run_1", [event("a")]);
		useExecutionEventsStore.getState().endStream("run_1", "maxStreamEvents", 4000);

		const s = useExecutionEventsStore.getState();
		expect(s.totalEvents).toBe(4000);
		expect(s.events).toHaveLength(1);
		expect(s.endReason).toBe("maxStreamEvents");
		expect(s.isStreaming).toBe(false);
	});

	it("falls back to what arrived when the complete frame named no total", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvents("run_1", [event("a")]);
		useExecutionEventsStore.getState().endStream("run_1", "error", null);

		// Never left null once ended: the tab's truncation disclosure compares
		// the total against the row count, and null would read as "no events".
		expect(useExecutionEventsStore.getState().totalEvents).toBe(1);
	});

	describe("handing the feed to another request's stream (#3352)", () => {
		/** Each replaced request's run, which is what the pane names. */
		const replaced = () =>
			Object.fromEntries(
				Object.entries(useExecutionEventsStore.getState().replacedFeeds).map(
					([requestId, feed]) => [requestId, feed.runId]
				)
			);

		it("empties the feed at hand-over and records the run once the stream starts", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().addEvents("run_B", [event("b")]);

			useExecutionEventsStore.getState().handOver("req_A");

			const s = useExecutionEventsStore.getState();
			expect(s).toMatchObject({ requestId: null, runId: null, isStreaming: false });
			expect(s.events).toEqual([]);
			// Mutation check: record in `handOver` again and a send that never
			// opens a stream leaves this entry behind.
			expect(replaced()).toEqual({});

			start("run_A", "req_A");
			expect(replaced()).toEqual({ req_B: "run_B" });
			expect(useExecutionEventsStore.getState().displaced).toBeNull();
		});

		it("keeps the displaced feed for the next stream that does start", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_A");
			// req_A's start failed; req_C's is the stream that takes the feed.
			useExecutionEventsStore.getState().handOver("req_C");
			expect(replaced()).toEqual({});

			start("run_C", "req_C");
			expect(replaced()).toEqual({ req_B: "run_B" });
		});

		it("records nothing when the displaced request streams again itself", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_A");
			start("run_B2", "req_B");
			expect(replaced()).toEqual({});
		});

		it("records nothing for a request's own re-send", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_B");
			start("run_B2", "req_B");
			expect(replaced()).toEqual({});
		});

		it("records nothing for a stream that had already ended", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().endStream("run_B", "completed", 0);
			useExecutionEventsStore.getState().handOver("req_A");
			start("run_A", "req_A");
			expect(replaced()).toEqual({});
		});

		it("forgets one request's record and keeps the others'", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_A");
			start("run_A", "req_A");
			useExecutionEventsStore.getState().handOver("req_C");
			start("run_C", "req_C");
			expect(replaced()).toEqual({ req_B: "run_B", req_A: "run_A" });

			useExecutionEventsStore.getState().beginSend("req_B");
			expect(replaced()).toEqual({ req_A: "run_A" });
		});

		it("carries the Send snapshot from the live stream to the replaced feed (#3382)", () => {
			const sent = sentTo("https://b.example.test");
			useExecutionEventsStore.getState().startStream({
				requestId: "req_B",
				runId: "run_B",
				eventsUrl: "/runs/run_B/events",
				leftOut: LEFT_OUT,
				sent,
			});
			useExecutionEventsStore.getState().handOver("req_A");
			start("run_A", "req_A");

			// Mutation check: build the displaced feed from the ids alone and the
			// run's stored response loses what its Send knew.
			expect(useExecutionEventsStore.getState().replacedFeeds.req_B).toEqual({
				runId: "run_B",
				sent,
				leftOut: LEFT_OUT,
				finalized: false,
			});
			// The new stream starts with a snapshot of its own, or none.
			expect(useExecutionEventsStore.getState().sent).toBeNull();
		});

		it("clear() forgets a displaced feed too", () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_A");
			useExecutionEventsStore.getState().clear();
			start("run_A", "req_A");
			expect(replaced()).toEqual({});
		});
	});

	describe("claiming a run for its finalisation (#3382)", () => {
		const claim = (runId: string) =>
			useExecutionEventsStore.getState().claimFinalization(runId);
		/** B streams, then A's stream takes the feed over: run_B is a replaced feed. */
		const replaceB = () => {
			start("run_B", "req_B");
			useExecutionEventsStore.getState().handOver("req_A");
			start("run_A", "req_A");
		};

		it("hands an ended stream over once, with its owner and snapshot", () => {
			const sent = sentTo("https://a.example.test");
			useExecutionEventsStore.getState().startStream({
				requestId: "req_1",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
				leftOut: LEFT_OUT,
				sent,
			});
			useExecutionEventsStore.getState().beginSend("req_1");
			expect(claim("run_1")).toBeNull();

			useExecutionEventsStore.getState().endStream("run_1", "completed", 0);
			expect(claim("run_1")).toEqual({
				requestId: "req_1",
				runId: "run_1",
				sent,
				leftOut: LEFT_OUT,
				sends: 1,
			});
			// Mutation check: drop the `finalized` test in `claimableRun` and a
			// remounted builder fetches the same run again.
			expect(claim("run_1")).toBeNull();
			expect(claim("run_unknown")).toBeNull();
		});

		it("hands a replaced feed over once, and again after a release", () => {
			replaceB();
			expect(claim("run_B")).toMatchObject({ requestId: "req_B", runId: "run_B" });
			expect(claim("run_B")).toBeNull();

			// Mutation check: make `releaseFinalization` a no-op and a report that
			// failed to fetch is never asked for again.
			useExecutionEventsStore.getState().releaseFinalization("run_B");
			expect(claim("run_B")).toMatchObject({ requestId: "req_B", runId: "run_B" });
		});

		it("resets the held stream's claim with the stream itself", () => {
			start("run_1");
			useExecutionEventsStore.getState().endStream("run_1", "completed", 0);
			claim("run_1");
			expect(useExecutionEventsStore.getState().finalized).toBe(true);

			start("run_2");
			expect(useExecutionEventsStore.getState().finalized).toBe(false);
			useExecutionEventsStore.getState().endStream("run_2", "completed", 0);
			claim("run_2");
			useExecutionEventsStore.getState().handOver("req_other");
			expect(useExecutionEventsStore.getState().finalized).toBe(false);
		});

		it("counts a request's sends, and forgets its replaced feed on the next one", () => {
			replaceB();
			useExecutionEventsStore.getState().beginSend("req_B");
			useExecutionEventsStore.getState().beginSend("req_B");

			expect(useExecutionEventsStore.getState().sendCounts).toEqual({ req_B: 2 });
			expect(useExecutionEventsStore.getState().replacedFeeds).toEqual({});
			expect(claim("run_B")).toBeNull();

			useExecutionEventsStore.getState().clear();
			expect(useExecutionEventsStore.getState().sendCounts).toEqual({});
		});
	});
});
