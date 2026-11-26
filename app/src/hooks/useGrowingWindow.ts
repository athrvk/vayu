/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Render the first N of a long list, and grow N as the end scrolls into view. Nothing is dropped:
 * the rows arrive as the reader reaches them, because on a long list it is the DOM that falls over,
 * not the data.
 *
 * **Why not a virtualisation library.** Log lines wrap, so their heights vary, and variable-height
 * windowing means measuring rows and maintaining a scroll map forever: a standing maintenance cost
 * and a class of bug (jumping scrollbars, wrong offsets after a filter) tedious to keep fixed.
 * Growing a plain list costs one observer and no bookkeeping, and pairs with
 * `content-visibility: auto` on the rows, which lets Chromium skip layout for whatever is off
 * screen. Between them the rendered count stays bounded in *cost* without being bounded in
 * *content*.
 *
 * That argument is about rows whose heights vary. Where rows are a fixed height by construction
 * there is nothing to measure and no map to maintain, and a real window is cheap: the collection
 * tree mounts only the rows in view (`modules/collections/useTreeWindow.ts`, #2543).
 *
 * **What resets it.** A new list starts at the top again, and `resetKey` is how a caller says which
 * list it holds. The length is the default, and right for a list that only changes by being
 * replaced; a list that grows in place (a run streaming its steps) needs its own key, or every
 * arrival snaps the window shut on a reader who had scrolled into it.
 *
 * **Why an observer rather than a scroll handler.** A scroll listener fires continuously, has to be
 * throttled, and must know which element scrolls, here an ancestor the hook cannot see. An observer
 * fires once when the sentinel appears and needs nothing about the scroller.
 *
 * **Growing upward needs the reader's place held.** Six callers grow downward, where rows mount
 * below the reader and nothing moves. The Console grows upward, from a sentinel above its rows, and
 * rows mounted above the view push it down; at `scrollTop` 0 the browser does not hold it, so the
 * sentinel would stay in view and the window stop at one step. That caller passes `beforeGrow`
 * (`useHoldPlace`, which moves the scroller by the height added above).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface GrowingWindow {
	/** How many items to render right now. */
	visible: number;
	/** Attach to an element at the end of the rendered list. */
	sentinelRef: (node: HTMLElement | null) => void;
	/** True while items remain unrendered - drives the "showing X of Y" line. */
	hasMore: boolean;
	/**
	 * Grow by one step without waiting for the sentinel: for a caller whose
	 * reader reaches the end by something other than scrolling (keyboard focus
	 * on the last row can leave the sentinel just outside the scroller).
	 */
	showMore: () => void;
}

/** The default window size, and the amount each growth adds to it. */
export const GROWING_WINDOW_STEP = 200;

export function useGrowingWindow(
	total: number,
	step = GROWING_WINDOW_STEP,
	/**
	 * What identifies *which* list this is, if the length does not. Defaults to the length, right
	 * for a list that only changes by being replaced (a different response's logs, a re-filtered
	 * set of rows). A caller whose list also *grows in place* must say so: there the length changes
	 * without the list changing (#1153).
	 */
	resetKey: unknown = total,
	/**
	 * Runs just before the sentinel grows the window. A caller that grows *upward* (the sentinel
	 * above its rows) passes `useHoldPlace`'s function here so the reader keeps their place; a
	 * window that grows downward has no use for it.
	 */
	beforeGrow?: () => void
): GrowingWindow {
	const [visible, setVisible] = useState(step);
	const observerRef = useRef<IntersectionObserver | null>(null);

	/*
	 * A new list is a new window. Otherwise switching to a response with fewer logs keeps the
	 * previous one's grown count (harmless), while switching to a longer one starts already
	 * scrolled deep into it.
	 *
	 * A list that grew is not a list that changed: a live scenario run appends to the same list for
	 * its duration, and resetting on the length would throw the reader back to the first `step`
	 * rows, scroll position included, on every batch of steps. Hence a key, not the length.
	 *
	 * Adjusted during render, not in an effect: React documents this as the way to reset state when
	 * a prop changes (it re-renders at once and never commits the stale value, where an effect
	 * paints the wrong window first), and `react-hooks/set-state-in-effect` flags the effect form
	 * for that reason.
	 */
	const [seenKey, setSeenKey] = useState(resetKey);
	if (!Object.is(seenKey, resetKey)) {
		setSeenKey(resetKey);
		setVisible(step);
	}

	/*
	 * A callback ref, not `useRef` + `useEffect`: the sentinel remounts every time the window grows
	 * (it moves to the new end of the list), and an effect keyed on a ref object never re-runs for
	 * that, so it would observe the first sentinel only and the list would grow exactly once.
	 */
	const sentinelRef = useCallback(
		(node: HTMLElement | null) => {
			observerRef.current?.disconnect();
			if (!node) return;

			/*
			 * No observer, no windowing: show everything. Unreachable in the app (Electron's
			 * Chromium has `IntersectionObserver`); it exists for jsdom, and because rendering it
			 * all is the honest degradation: withholding rows with no way to reach them would turn
			 * a missing optimisation into missing data.
			 */
			if (typeof IntersectionObserver === "undefined") {
				setVisible(total);
				return;
			}

			observerRef.current = new IntersectionObserver((entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					beforeGrow?.();
					setVisible((n) => Math.min(n + step, total));
				}
			});
			observerRef.current.observe(node);
		},
		[step, total, beforeGrow]
	);

	useEffect(() => () => observerRef.current?.disconnect(), []);

	const showMore = useCallback(() => setVisible((n) => Math.min(n + step, total)), [step, total]);

	return { visible, sentinelRef, hasMore: visible < total, showMore };
}
