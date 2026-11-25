/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keep the reader's place when a window grows above the rows they are looking at (#3675). An
 * upward-growing window mounts rows ahead of the first one, pushing everything the reader sees down
 * the scroller. Chromium's scroll anchoring does not hold the view at `scrollTop` 0, so the
 * sentinel that asked for the growth stays in view, its observer has nothing new to report, and the
 * window stops at one step however much is held. Calling the returned function just before the
 * growth records where the list's first row sits; the commit that follows moves the scroller by
 * however far that row went, so the sentinel leaves the viewport and the next scroll up reaches it
 * again.
 *
 * The first row is measured by where it *is*, not by how much the scroll height grew: a window at
 * its cap gives rows up at the far end as it grows, so the height added above is not the height
 * gained, and where the browser did anchor the view the row has not moved and nothing is added
 * twice.
 *
 * Call it before the component's own scroll effects: an effect that pins the list to its end runs
 * after this one and wins. The first row is the first child of the first `ul` in @p scroller.
 */

import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

interface HeldRow {
	/** The element the ref held when the row was measured: the one the effect moves. */
	scroller: HTMLElement;
	row: Element;
	top: number;
}

export function useHoldPlace(scroller: RefObject<HTMLElement | null>): () => void {
	const held = useRef<HeldRow | null>(null);
	// The caller's ref object lives as long as the component does; holding it once keeps `hold` stable.
	const scrollerRef = useRef(scroller);

	const hold = useCallback(() => {
		const element = scrollerRef.current.current;
		const row = element?.querySelector("ul")?.firstElementChild;
		held.current =
			element && row
				? { scroller: element, row, top: row.getBoundingClientRect().top }
				: null;
	}, []);

	useLayoutEffect(() => {
		const before = held.current;
		held.current = null;
		if (!before || !before.row.isConnected) return;
		before.scroller.scrollTop += before.row.getBoundingClientRect().top - before.top;
	});

	return hold;
}
