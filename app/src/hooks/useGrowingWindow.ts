/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Render the first N of a long list, and grow N as the end scrolls into view.
 *
 * The response pane's console output is unbounded - `script_engine.cpp` pushes
 * every `console.log` line into a vector with no cap - so a script with a loop
 * can produce a hundred thousand lines, and the user asked for every one of
 * them. Capping was the wrong instinct: the engine holds them comfortably, and
 * what actually falls over is the DOM. So nothing is dropped; the rows simply
 * arrive as you reach them.
 *
 * **Why not a virtualisation library.** Log lines wrap, so their heights vary,
 * and variable-height windowing means measuring rows and maintaining a scroll
 * map forever - a standing maintenance cost and a class of bug (jumping
 * scrollbars, wrong offsets after a filter) that is tedious to keep fixed.
 * Growing a plain list costs one observer and no bookkeeping, and pairs with
 * `content-visibility: auto` on the rows, which lets Chromium skip layout for
 * whatever is off screen. Between them the rendered count stays bounded in
 * *cost* without being bounded in *content*.
 *
 * **What resets it.** A new list starts at the top again, and `resetKey` is how
 * a caller says which list it is holding. The length is the default answer and
 * the right one for a list that only ever changes by being replaced; a list that
 * grows in place - a run streaming its steps - needs its own key, or every
 * arrival snaps the window shut on a reader who had scrolled into it.
 *
 * **Why an observer rather than a scroll handler.** A scroll listener fires
 * continuously and has to be throttled, and it needs to know which element
 * scrolls - here that is an ancestor the hook cannot see. An observer fires
 * once when the sentinel appears and is told nothing about the scroller.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface GrowingWindow {
	/** How many items to render right now. */
	visible: number;
	/** Attach to an element at the end of the rendered list. */
	sentinelRef: (node: HTMLElement | null) => void;
	/** True while items remain unrendered - drives the "showing X of Y" line. */
	hasMore: boolean;
}

/** The default window size, and the amount each growth adds to it. */
export const GROWING_WINDOW_STEP = 200;

export function useGrowingWindow(
	total: number,
	step = GROWING_WINDOW_STEP,
	/**
	 * What identifies *which* list this is, if the length does not.
	 *
	 * Defaults to the length, which is the right answer for a list that only
	 * changes by being replaced - a different response's logs, a re-filtered set
	 * of rows. A caller whose list also *grows in place* must say so, because
	 * there the length changes without the list changing (issue #1153).
	 */
	resetKey: unknown = total
): GrowingWindow {
	const [visible, setVisible] = useState(step);
	const observerRef = useRef<IntersectionObserver | null>(null);

	/*
	 * A new list is a new window. Without this, switching to a response with
	 * fewer logs keeps the previous one's grown count - harmless - while
	 * switching to a longer one starts already scrolled deep into it.
	 *
	 * What it must not do is treat a list that grew as a list that changed: a
	 * live scenario run appends to the same list for its duration, and resetting
	 * on the length threw the reader back to the first `step` rows on every
	 * batch of steps that arrived, scroll position included. That is why the
	 * comparison is against a key rather than the length itself.
	 *
	 * Adjusted during render rather than in an effect. React documents this as
	 * the way to reset state when a prop changes: it re-renders immediately with
	 * the new value and never commits the stale one, where an effect paints the
	 * wrong window first and then corrects it. `react-hooks/set-state-in-effect`
	 * flags the effect form for exactly that reason.
	 */
	const [seenKey, setSeenKey] = useState(resetKey);
	if (!Object.is(seenKey, resetKey)) {
		setSeenKey(resetKey);
		setVisible(step);
	}

	/*
	 * A callback ref, not `useRef` + `useEffect`. The sentinel unmounts and
	 * remounts every time the window grows (it moves to the new end of the
	 * list), and an effect keyed on a ref object never re-runs for that - it
	 * would observe the first sentinel and then nothing, so the list would grow
	 * exactly once.
	 */
	const sentinelRef = useCallback(
		(node: HTMLElement | null) => {
			observerRef.current?.disconnect();
			if (!node) return;

			/*
			 * No observer, no windowing - show everything.
			 *
			 * Chromium has had `IntersectionObserver` for years and this ships in
			 * Electron, so the branch is unreachable in the app. It exists because
			 * jsdom has none, and because the honest degradation is to render all
			 * of it: withholding rows with no way to reach them would turn a
			 * missing optimisation into missing data.
			 */
			if (typeof IntersectionObserver === "undefined") {
				setVisible(total);
				return;
			}

			observerRef.current = new IntersectionObserver((entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setVisible((n) => Math.min(n + step, total));
				}
			});
			observerRef.current.observe(node);
		},
		[step, total]
	);

	useEffect(() => () => observerRef.current?.disconnect(), []);

	return { visible, sentinelRef, hasMore: visible < total };
}
