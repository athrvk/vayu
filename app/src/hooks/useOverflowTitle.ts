/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useRef } from "react";

/**
 * useOverflowTitle
 *
 * Attaches a native `title` tooltip to a truncating element — but only while
 * the text is actually cut off.
 *
 * An unconditional `title` pops a tooltip on every hover, including names that
 * are fully readable. The tooltip should only ever tell the user something the
 * screen does not: it appears when the text is ellipsed and disappears when the
 * user widens the drawer enough to read it.
 *
 * The attribute is set imperatively rather than through state. Rendering it
 * would mean measure -> setState -> render -> measure, and a ResizeObserver
 * that calls setState during layout is the standard way to get a feedback loop.
 * Nothing else reads this attribute, so writing the DOM directly is both safe
 * and cheaper.
 *
 * Requires the element to truncate (`overflow: hidden`), which is what makes
 * `scrollWidth > clientWidth` meaningful — without it the element grows and the
 * two are always equal.
 *
 * @param text The full text. Also the re-measure trigger when it changes.
 */
export function useOverflowTitle<T extends HTMLElement = HTMLElement>(text: string | undefined) {
	const ref = useRef<T | null>(null);

	const sync = useCallback(() => {
		const el = ref.current;
		if (!el) return;

		// +1: scrollWidth and clientWidth are rounded to integers, so a
		// sub-pixel layout can report a 1px difference with nothing clipped.
		// Without this margin, rows show a tooltip repeating text already fully
		// visible — the exact thing this hook exists to avoid.
		const overflowing = el.scrollWidth > el.clientWidth + 1;

		if (overflowing && text) el.setAttribute("title", text);
		else el.removeAttribute("title");
	}, [text]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		sync();

		// Re-measure when the element's own box changes (drawer resize, window
		// resize, sibling badges appearing) — a name that fit at 320px may not
		// fit at 200px, and vice versa.
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		return () => observer.disconnect();
	}, [sync]);

	return ref;
}
