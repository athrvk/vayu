/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A commit per flush window, not per frame (issue #1158).
 *
 * A design-mode stream is relayed frame by frame, and each frame used to be a
 * full copy of the event list plus a store notify plus a re-render of the whole
 * response pane. What is pinned here is that the number of commits follows the
 * cadence rather than the frame rate - and, on every path that ends a stream,
 * that nothing is lost in exchange for the commits saved. A buffered tail is
 * worse than an unbatched one: the relay will not re-deliver it, because the
 * resume point has already passed it.
 *
 * The frame parsers and the reconnect backoff are pinned separately, in
 * `useExecutionEvents.test.ts`, which needs no DOM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useClientSettingsStore, useExecutionEventsStore } from "@/stores";
import { useExecutionEvents } from "./useExecutionEvents";

const FLUSH_MS = 500;

/** Every source the hook opened, with its handlers reachable. */
class MockEventSource {
	static instances: MockEventSource[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, ((event: Event) => void)[]>();

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, handler: (event: Event) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
	}

	/** Deliver a frame the relay would have written under @p type. */
	emit(type: string, payload: unknown, lastEventId = "") {
		const event = new MessageEvent(type, { data: JSON.stringify(payload), lastEventId });
		if (type === "message") this.onmessage?.(event);
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}

	close() {
		this.closed = true;
	}
}

const latest = () => {
	const all = MockEventSource.instances;
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
};

/** Relay one upstream event, the way `onmessage` receives it. */
const deliver = (n: number) =>
	act(() => latest().emit("message", { event: "token", data: `e${n}` }, String(n)));

const committed = () => useExecutionEventsStore.getState().events.map((e) => e.data);

const startStream = (runId = "run_1") =>
	act(() =>
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId,
			eventsUrl: `/runs/${runId}/events`,
		})
	);

beforeEach(() => {
	MockEventSource.instances = [];
	useExecutionEventsStore.getState().clear();
	useClientSettingsStore.setState({ liveRefreshMs: FLUSH_MS });
	vi.stubGlobal("EventSource", MockEventSource);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("useExecutionEvents batching", () => {
	it("commits one batch per flush window rather than one per frame", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream();

		// The first frame commits on the leading edge: a reader watching a
		// stream open should not wait a window to see it produced anything.
		deliver(0);
		expect(committed()).toEqual(["e0"]);

		// Everything inside the window rides one trailing commit, however many
		// arrive. Reverting the batcher makes each of these a commit of its own.
		const before = useExecutionEventsStore.getState().events;
		for (let n = 1; n <= 8; n += 1) deliver(n);
		expect(useExecutionEventsStore.getState().events).toBe(before);

		act(() => void vi.advanceTimersByTime(FLUSH_MS));
		expect(committed()).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);

		unmount();
	});

	it("commits the buffer on the complete frame, before the total is folded in", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream();

		deliver(0);
		deliver(1);
		// Still inside the window, so the second frame is buffered: without the
		// flush it would be the stream's last row, lost between the relay
		// closing and the stored trace arriving.
		expect(committed()).toEqual(["e0"]);

		// No total on the frame, which is where the ordering shows: `endStream`
		// falls back to `events.length`, so a tail still in the buffer would be
		// missing from the count as well as from the list.
		act(() => latest().emit("complete", { reason: "completed" }));

		const s = useExecutionEventsStore.getState();
		expect(s.events.map((e) => e.data)).toEqual(["e0", "e1"]);
		expect(s.totalEvents).toBe(2);
		expect(s.isStreaming).toBe(false);

		unmount();
	});

	it("commits the buffer when the reconnects are spent, under the notice saying so", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream();

		deliver(0);
		deliver(1);
		expect(committed()).toEqual(["e0"]);

		// Every retry, then one more failure: the hook gives up and ends the
		// stream, and what arrived belongs under that notice rather than with it.
		for (let attempt = 0; attempt <= 5; attempt += 1) {
			act(() => void latest().onerror?.());
			act(() => void vi.advanceTimersByTime(30_000));
		}

		const s = useExecutionEventsStore.getState();
		expect(s.events.map((e) => e.data)).toEqual(["e0", "e1"]);
		expect(s.endReason).toBe("error");
		expect(s.error).toContain("Lost the event stream");

		unmount();
	});

	it("commits what a torn-down subscription still held for the run it belongs to", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream();

		deliver(0);
		deliver(1);
		expect(committed()).toEqual(["e0"]);

		// Unmounting the builder is not the stream ending. The relay resumes
		// after the frame it last acknowledged, so a discarded buffer is a row
		// nothing will ever deliver again.
		act(() => unmount());
		expect(committed()).toEqual(["e0", "e1"]);
	});

	it("keeps a buffered frame across a reconnect, and resumes after the one it received", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream();

		deliver(0);
		deliver(1);
		expect(committed()).toEqual(["e0"]);

		// A dropped socket is not the stream ending: the batcher's timer is its
		// own, so what it holds survives the reconnect rather than going with the
		// `EventSource`. The resume point is the frame *received*, not the frame
		// committed - the two are no longer the same thing, and reading the
		// committed one would ask the relay to re-send a row already buffered.
		act(() => void latest().onerror?.());
		act(() => void vi.advanceTimersByTime(30_000));

		expect(latest().url).toContain("lastEventId=1");

		deliver(2);
		act(() => void vi.advanceTimersByTime(FLUSH_MS));

		expect(committed()).toEqual(["e0", "e1", "e2"]);
		expect(useExecutionEventsStore.getState().isStreaming).toBe(true);

		unmount();
	});

	it("drops what a replaced stream left buffered rather than committing it into the next", () => {
		const { unmount } = renderHook(() => useExecutionEvents());
		startStream("run_1");

		deliver(0);
		deliver(1);

		// The next Send is what ends this one: the store clears its rows and
		// takes the new run, so `run_1`'s buffered frame belongs to a list
		// nothing will show. The store's run guard is what drops it.
		startStream("run_2");
		act(() => void vi.advanceTimersByTime(FLUSH_MS * 2));

		expect(useExecutionEventsStore.getState().runId).toBe("run_2");
		expect(committed()).toEqual([]);

		unmount();
	});
});
