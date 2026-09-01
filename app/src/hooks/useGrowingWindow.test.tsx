/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * What resets the growing window, and what must not (issue #1153).
 *
 * The hook renders the first N of a long list and grows N as the end is
 * reached. Resetting N is the part with two callers pulling opposite ways: a
 * list that was *replaced* - a different response's logs, a re-filtered set of
 * rows - should start at its own top, while a list that is *the same list,
 * longer* must not, or a live scenario run throws its reader back to the first
 * screenful on every batch of steps that arrives.
 *
 * The length alone cannot tell those apart, which is what `resetKey` is for.
 * It defaults to the length, so the three call sites that only ever replace
 * their list keep the behaviour they were written against - the first case
 * below is that default, and it is why the default is not simply "never reset".
 *
 * jsdom has no `IntersectionObserver`, and the hook's documented degradation
 * there is to show everything. These cases therefore stub one that never
 * intersects, so the window only ever moves for the reasons under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGrowingWindow, GROWING_WINDOW_STEP } from "./useGrowingWindow";

/** The observer the hook attaches to its sentinel, held so a case can fire it. */
let intersect: (() => void) | null = null;

beforeEach(() => {
	intersect = null;
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private readonly callback: IntersectionObserverCallback) {}
			observe() {
				intersect = () =>
					this.callback(
						[{ isIntersecting: true } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver
					);
			}
			disconnect() {
				intersect = null;
			}
		}
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Attach the sentinel and reach it once, the way scrolling to the end does. */
function scrollToEnd(sentinelRef: (node: HTMLElement | null) => void): void {
	act(() => sentinelRef(document.createElement("p")));
	act(() => intersect?.());
}

describe("useGrowingWindow", () => {
	it("starts at one step and grows by one step when the end is reached", () => {
		const { result } = renderHook(() => useGrowingWindow(1_000));

		expect(result.current.visible).toBe(GROWING_WINDOW_STEP);
		expect(result.current.hasMore).toBe(true);

		scrollToEnd(result.current.sentinelRef);

		expect(result.current.visible).toBe(GROWING_WINDOW_STEP * 2);
	});

	it("starts a replaced list at its own top, keyed on the length by default", () => {
		// The default `resetKey`, which is the length: a caller that says
		// nothing keeps the behaviour the response pane's console was written
		// against, where a changed length only ever means a different list.
		const { result, rerender } = renderHook(({ total }) => useGrowingWindow(total), {
			initialProps: { total: 1_000 },
		});

		scrollToEnd(result.current.sentinelRef);
		expect(result.current.visible).toBe(GROWING_WINDOW_STEP * 2);

		rerender({ total: 900 });

		expect(result.current.visible).toBe(GROWING_WINDOW_STEP);
	});

	it("holds a grown window while the same list gets longer", () => {
		/*
		 * The defect this fixes: a live scenario run appends to one list for its
		 * duration, and the window reset on every length change - so a reader
		 * who had scrolled into the run's steps was returned to the first 200 of
		 * them by the next batch to arrive, several times a second. Revert the
		 * key and this reads 200.
		 */
		const { result, rerender } = renderHook(
			({ total }) => useGrowingWindow(total, GROWING_WINDOW_STEP, "run_1"),
			{ initialProps: { total: 1_000 } }
		);

		scrollToEnd(result.current.sentinelRef);
		expect(result.current.visible).toBe(GROWING_WINDOW_STEP * 2);

		rerender({ total: 1_400 });
		rerender({ total: 1_900 });

		expect(result.current.visible).toBe(GROWING_WINDOW_STEP * 2);
		expect(result.current.hasMore).toBe(true);
	});

	it("starts at the top again when the key says this is a different list", () => {
		// The other half of the same rule: the scenario view's chips and search
		// box narrow to a genuinely different list, and that one does reset.
		const { result, rerender } = renderHook(
			({ key }) => useGrowingWindow(1_000, GROWING_WINDOW_STEP, key),
			{ initialProps: { key: "run_1::" } }
		);

		scrollToEnd(result.current.sentinelRef);
		expect(result.current.visible).toBe(GROWING_WINDOW_STEP * 2);

		rerender({ key: "run_1:failed:" });

		expect(result.current.visible).toBe(GROWING_WINDOW_STEP);
	});

	it("has no more to show once the window covers the list", () => {
		const { result } = renderHook(() => useGrowingWindow(10));
		expect(result.current.hasMore).toBe(false);
	});
});
