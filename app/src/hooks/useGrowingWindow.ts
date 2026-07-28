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

export function useGrowingWindow(total: number, step = 200): GrowingWindow {
	const [visible, setVisible] = useState(step);
	const observerRef = useRef<IntersectionObserver | null>(null);

	/*
	 * A new list is a new window. Without this, switching to a response with
	 * fewer logs keeps the previous one's grown count - harmless - while
	 * switching to a longer one starts already scrolled deep into it.
	 *
	 * Adjusted during render rather than in an effect. React documents this as
	 * the way to reset state when a prop changes: it re-renders immediately with
	 * the new value and never commits the stale one, where an effect paints the
	 * wrong window first and then corrects it. `react-hooks/set-state-in-effect`
	 * flags the effect form for exactly that reason.
	 */
	const [seenTotal, setSeenTotal] = useState(total);
	if (seenTotal !== total) {
		setSeenTotal(total);
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
