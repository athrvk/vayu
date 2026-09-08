/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { scrollWithin } from "./scroll-within";

/** jsdom has no layout, so both rects are stubbed directly on the element. */
function stubRect(el: Element, rect: Partial<DOMRect>) {
	el.getBoundingClientRect = () =>
		({
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			toJSON() {},
			...rect,
		}) as DOMRect;
}

function makeContainer(scrollTop: number, rect: Partial<DOMRect>) {
	const container = document.createElement("div");
	container.scrollTop = scrollTop;
	stubRect(container, rect);
	container.scrollTo = vi.fn();
	return container;
}

describe("scrollWithin", () => {
	it("scrolls the container by the amount that centres a target below the viewport", () => {
		const container = makeContainer(0, { top: 0, height: 200 });
		const target = document.createElement("div");
		stubRect(target, { top: 500, height: 40 });

		scrollWithin(container, target, { block: "center" });

		// targetTop (relative) = 500, centred: 500 + 20 - 100 = 420
		expect(container.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 420 });
	});

	it("scrolls nothing when the target is already centred", () => {
		// containerRect: top 0, height 200. scrollTop 420.
		// target absolute top (viewport-relative) chosen so that
		// targetTop(relative) + height/2 - containerHeight/2 === 420.
		const container = makeContainer(420, { top: 0, height: 200 });
		const target = document.createElement("div");
		// relative targetTop = viewportTop - 0 + 420; want relative + 20 - 100 = 420
		// => relative = 500 => viewportTop = 500 - 420 = 80
		stubRect(target, { top: 80, height: 40 });

		scrollWithin(container, target, { block: "center" });

		expect(container.scrollTo).not.toHaveBeenCalled();
	});

	it("scrolls the minimum needed for 'nearest', not to the centre", () => {
		const container = makeContainer(0, { top: 0, height: 200 });
		const target = document.createElement("div");
		// Below the visible window (0-200): top 260, height 20 -> bottom 280.
		stubRect(target, { top: 260, height: 20 });

		scrollWithin(container, target, { block: "nearest" });

		// Minimum scroll so the bottom (280) aligns with the container's bottom:
		// 280 - 200 = 80, not the centring value (260 + 10 - 100 = 170).
		expect(container.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 80 });
	});

	it("does not call scrollTo for 'nearest' when the target is already fully visible", () => {
		const container = makeContainer(0, { top: 0, height: 200 });
		const target = document.createElement("div");
		stubRect(target, { top: 50, height: 20 });

		scrollWithin(container, target, { block: "nearest" });

		expect(container.scrollTo).not.toHaveBeenCalled();
	});

	it("never calls scrollIntoView - the whole point is staying inside one container", () => {
		const spy = vi.spyOn(Element.prototype, "scrollIntoView");
		const container = makeContainer(0, { top: 0, height: 200 });
		const target = document.createElement("div");
		stubRect(target, { top: 500, height: 40 });

		scrollWithin(container, target, { block: "center" });

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
