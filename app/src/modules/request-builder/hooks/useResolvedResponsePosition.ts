/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useLayoutEffect, type RefObject } from "react";
import { useLayoutStore, resolveResponseArrangement, type ResponseArrangement } from "@/stores";
import { AUTO_RESPONSE_BELOW_MAX_WIDTH, AUTO_RESPONSE_HYSTERESIS } from "@/constants/layout";

export { AUTO_RESPONSE_BELOW_MAX_WIDTH };

/**
 * The arrangement `auto` picks for a builder `width` px wide, given the one it
 * is showing now.
 *
 * Below under the threshold, beside at or above it - with a band on the way
 * back: a builder that stacked at 879px does not un-stack until it is
 * `AUTO_RESPONSE_HYSTERESIS` wider, so a drawer or window drag that hovers
 * around the threshold does not re-arrange the split on every pixel. Exported
 * for the unit test; the hook is the only production caller.
 */
export function pickAutoArrangement(
	width: number,
	current: ResponseArrangement
): ResponseArrangement {
	if (current === "beside") {
		return width < AUTO_RESPONSE_BELOW_MAX_WIDTH ? "below" : "beside";
	}
	return width >= AUTO_RESPONSE_BELOW_MAX_WIDTH + AUTO_RESPONSE_HYSTERESIS ? "beside" : "below";
}

/**
 * Which arrangement the builder inside `containerRef` should draw right now
 * (issue #1711): the `responsePosition` setting itself, or - for `auto` - the
 * one its own width calls for.
 *
 * The measurement is the container's, not the window's: the drawer and the
 * context bar take their share of the window first, and it is the pane left
 * over that has to fit a URL bar next to a JSON body. A `ResizeObserver` on
 * the container therefore sees every cause at once - a window resize, a drawer
 * drag, the context bar opening - with nothing to subscribe to separately.
 *
 * `auto`'s pick is written to `layout-store` rather than kept here, because
 * two readers outside this tree need it: the Dock button shows the current
 * arrangement while the setting says `auto`, and `toggleResponsePosition`
 * flips *from* it. The observer runs only while the setting is `auto`; an
 * explicit Beside or Below costs no measurement at all.
 *
 * A layout effect, so the first paint of an `auto` builder already has the
 * right arrangement instead of drawing Beside and then flipping.
 */
export function useResolvedResponsePosition(
	containerRef: RefObject<HTMLElement | null>
): ResponseArrangement {
	const setting = useLayoutStore((s) => s.responsePosition);
	const arrangement = useLayoutStore(resolveResponseArrangement);
	const setAutoResponseArrangement = useLayoutStore((s) => s.setAutoResponseArrangement);

	useLayoutEffect(() => {
		if (setting !== "auto") return;
		const el = containerRef.current;
		if (!el) return;

		const measure = () => {
			const width = el.getBoundingClientRect().width;
			// A container that has not been laid out yet (a hidden tab, the
			// first frame of a test) reports 0, and 0 is not "narrow" - it is
			// "unknown", so it leaves the last pick standing.
			if (width <= 0) return;
			const { autoResponseArrangement } = useLayoutStore.getState();
			const next = pickAutoArrangement(width, autoResponseArrangement);
			if (next !== autoResponseArrangement) setAutoResponseArrangement(next);
		};

		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [setting, containerRef, setAutoResponseArrangement]);

	return arrangement;
}
