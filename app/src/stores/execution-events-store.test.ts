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
import type { StreamEvent } from "@/types";

const event = (data: string): StreamEvent => ({ event: "message", data });

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
		useExecutionEventsStore.getState().addEvent("run_1", event("a"));
		useExecutionEventsStore.getState().addEvent("run_1", event("b"));

		expect(useExecutionEventsStore.getState().events.map((e) => e.data)).toEqual(["a", "b"]);
	});

	it("drops an event addressed to a run it is not holding", () => {
		start("run_2");
		useExecutionEventsStore.getState().addEvent("run_1", event("from the old socket"));

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
		useExecutionEventsStore.getState().addEvent("run_1", event("a"));
		useExecutionEventsStore.getState().endStream("run_1", "completed", 1);

		start("run_2");
		const s = useExecutionEventsStore.getState();
		expect(s.events).toEqual([]);
		expect(s.endReason).toBeNull();
		expect(s.totalEvents).toBeNull();
		expect(s.error).toBeNull();
	});

	it("keeps the engine's own total, which is not the row count once capped", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvent("run_1", event("a"));
		useExecutionEventsStore.getState().endStream("run_1", "maxStreamEvents", 4000);

		const s = useExecutionEventsStore.getState();
		expect(s.totalEvents).toBe(4000);
		expect(s.events).toHaveLength(1);
		expect(s.endReason).toBe("maxStreamEvents");
		expect(s.isStreaming).toBe(false);
	});

	it("falls back to what arrived when the complete frame named no total", () => {
		start("run_1");
		useExecutionEventsStore.getState().addEvent("run_1", event("a"));
		useExecutionEventsStore.getState().endStream("run_1", "error", null);

		// Never left null once ended: the tab's truncation disclosure compares
		// the total against the row count, and null would read as "no events".
		expect(useExecutionEventsStore.getState().totalEvents).toBe(1);
	});
});
