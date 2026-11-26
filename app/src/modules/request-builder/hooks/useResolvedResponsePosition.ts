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
 * The arrangement `auto` picks at `width` px, given the current one: below under the threshold,
 * beside at or above it, with a band on the way back (a builder stacked at 879px un-stacks only
 * `AUTO_RESPONSE_HYSTERESIS` wider), so a drag hovering at the threshold does not re-arrange per
 * pixel. Exported for the unit test; the hook is its only caller.
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
 * The arrangement the builder in `containerRef` draws now (#1711): the `responsePosition` setting,
 * or for `auto` what its own width calls for. The container is measured, not the window: the drawer
 * and context bar take their share first, and the leftover pane must fit a URL bar beside a body,
 * so one `ResizeObserver` sees every cause. `auto`'s pick goes to `layout-store`: the Dock button
 * shows it while the setting is `auto`, and `toggleResponsePosition` flips from it. The observer
 * runs only for `auto`. A layout effect, so an `auto` builder's first paint is right, not Beside
 * then flipped.
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
			// An unlaid-out container (a hidden tab, a test's first frame) reports 0, which is
			// "unknown", not narrow, so the last pick stands.
			if (width <= 0) return;
			const { autoResponseArrangement } = useLayoutStore.getState();
			const next = pickAutoArrangement(width, autoResponseArrangement);
			if (next !== autoResponseArrangement) setAutoResponseArrangement(next);
		};

		// The mount measurement runs in the layout effect, outside any observer delivery, so it may
		// flip synchronously and the first paint is right.
		measure();
		if (typeof ResizeObserver === "undefined") return;

		/*
		 * From the observer the flip waits a frame: a delivery that relayouts elements it already
		 * reported (the panel library observes the group and both panes, and a flip resizes all
		 * three) is the browser's "ResizeObserver loop completed with undelivered notifications",
		 * which `main.tsx` logs as a high-severity error. One old frame per threshold crossing is
		 * the whole cost.
		 */
		let frame: number | null = null;
		const observer = new ResizeObserver(() => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				measure();
			});
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [setting, containerRef, setAutoResponseArrangement]);

	return arrangement;
}
