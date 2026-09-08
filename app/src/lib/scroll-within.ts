/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Scroll `target` into view inside `container`, and nowhere else.
 *
 * `Element.scrollIntoView` walks every scrollable ancestor until the target is
 * satisfied, and Chromium counts an `overflow: hidden` box as scrollable for
 * that purpose - it has no scrollbar and no user gesture can move it, but a
 * script can, and once it has there is no way back (#1612). This scrolls
 * exactly one container: the target's offset is computed relative to it via
 * `getBoundingClientRect`, and the container's own `scrollTo` is the only
 * thing called. Ancestors are never touched, because nothing asks them to be.
 */
export function scrollWithin(
	container: Element,
	target: Element,
	{ block }: { block: "center" | "nearest" }
): void {
	const containerRect = container.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	const targetTop = targetRect.top - containerRect.top + container.scrollTop;
	const visibleTop = container.scrollTop;

	let top: number;
	if (block === "center") {
		top = targetTop + targetRect.height / 2 - containerRect.height / 2;
	} else {
		const targetBottom = targetTop + targetRect.height;
		const visibleBottom = visibleTop + containerRect.height;
		if (targetTop < visibleTop) {
			top = targetTop;
		} else if (targetBottom > visibleBottom) {
			top = targetBottom - containerRect.height;
		} else {
			return;
		}
	}

	if (top === visibleTop) return;
	container.scrollTo({ top });
}
