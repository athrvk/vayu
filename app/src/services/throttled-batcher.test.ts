/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The batcher's own contract, which both streaming services now depend on
 * (issue #1206). `load-test-service.test.ts` and `scenario-run-service.test.ts`
 * keep their behavioural cases - what a batch commits to is theirs - so what is
 * pinned here is only what the helper owns: the leading edge, the trailing
 * timer, the cadence it reads, and the two ways a buffer ends.
 *
 * The mutation checks are named per case: each says which line of
 * `throttled-batcher.ts` reverting would redden it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FLUSH_MS = 500;
let liveRefreshMs = FLUSH_MS;

vi.mock("@/stores", () => ({
	useClientSettingsStore: { getState: () => ({ liveRefreshMs }) },
}));

import { createThrottledBatcher } from "./throttled-batcher";
import { METRICS_UI_THROTTLE_MS } from "@/config/metrics";

describe("createThrottledBatcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		liveRefreshMs = FLUSH_MS;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("commits the first item at once, so a fast stream does not look slow to start", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(1);

		// The mutation check: drop `|| lastCommitTime === 0` from the leading-edge
		// condition and the run's first item waits out a whole window instead.
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith([1]);
	});

	it("carries everything inside one window on a single trailing commit", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge
		commit.mockClear();
		for (let i = 1; i <= 8; i++) batcher.push(i);

		// Nothing yet: the window that opened on the leading edge is still open.
		expect(commit).not.toHaveBeenCalled();

		// The mutation check: remove the trailing `setTimeout` and these eight
		// never arrive - the assertion below reddens on an empty mock.
		vi.advanceTimersByTime(FLUSH_MS);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("schedules one timer for a window, not one per item", () => {
		const commit = vi.fn();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge, no timer
		setTimeoutSpy.mockClear();
		for (let i = 1; i <= 5; i++) batcher.push(i);

		// The mutation check: drop the `timer === null` guard and each item
		// inside the window arms its own timer.
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		setTimeoutSpy.mockRestore();
	});

	it("re-opens the leading edge once a window has passed with nothing buffered", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(1); // leading edge
		vi.advanceTimersByTime(FLUSH_MS);
		batcher.push(2);

		// Two commits, both immediate: the second push is a window later, so it
		// takes the leading edge rather than waiting for a timer.
		expect(commit).toHaveBeenCalledTimes(2);
		expect(commit).toHaveBeenLastCalledWith([2]);
	});

	it("flush commits what is buffered, and is a no-op when nothing is", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge
		batcher.push(1);
		batcher.push(2);
		commit.mockClear();

		batcher.flush();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith([1, 2]);

		// Nothing left, so a second flush commits nothing - the property
		// `LoadTestService` leans on to tell an empty buffer from a full one.
		batcher.flush();
		expect(commit).toHaveBeenCalledTimes(1);

		// The mutation check for `clearTimer` inside `flush`: a stale timer left
		// armed here commits nothing (the buffer it would drain is empty), so
		// only the pending count shows it. Left uncleared per window on a long
		// run, that is the leak.
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(FLUSH_MS * 2);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("discard drops the buffer, its pending commit, and re-arms the leading edge", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge
		batcher.push(1);
		batcher.push(2);
		commit.mockClear();

		batcher.discard();

		// The mutation check for `clearTimer` inside `discard`. An armed timer
		// left behind commits nothing - it would drain a buffer this just
		// emptied - so the commit assertions below cannot see it, and only the
		// pending count can: a run replaced mid-flight leaks one timer per
		// window it had open.
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(FLUSH_MS * 2);

		expect(commit).not.toHaveBeenCalled();

		// The next item belongs to a list nothing has seen, so it leads again
		// rather than inheriting the discarded window's timestamp.
		batcher.push(3);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith([3]);
	});

	it("reads the live-refresh setting per push, so a change takes effect on the next item", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge at the 500ms cadence
		liveRefreshMs = 100;
		batcher.push(1);
		commit.mockClear();

		// The new cadence, not the one in force when the window opened.
		vi.advanceTimersByTime(100);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith([1]);
	});

	it("falls back to the module default when the setting is unset", () => {
		const commit = vi.fn();
		liveRefreshMs = 0;
		const batcher = createThrottledBatcher<number>(commit);

		batcher.push(0); // leading edge
		batcher.push(1);
		commit.mockClear();

		vi.advanceTimersByTime(METRICS_UI_THROTTLE_MS - 1);
		expect(commit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("never hands the commit an empty batch", () => {
		const commit = vi.fn();
		const batcher = createThrottledBatcher<number>(commit);

		batcher.flush();
		batcher.discard();
		vi.advanceTimersByTime(FLUSH_MS * 2);

		expect(commit).not.toHaveBeenCalled();
	});

	it("hands each commit its own array, not a buffer it keeps writing into", () => {
		const batches: number[][] = [];
		const batcher = createThrottledBatcher<number>((batch) => batches.push(batch));

		batcher.push(0); // leading edge
		batcher.push(1);
		vi.advanceTimersByTime(FLUSH_MS);
		batcher.push(2);
		vi.advanceTimersByTime(FLUSH_MS);

		// A batcher that reused one array would leave every recorded batch
		// pointing at the same, latest contents.
		expect(batches).toEqual([[0], [1], [2]]);
	});
});
