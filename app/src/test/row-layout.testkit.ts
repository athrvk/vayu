/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A layout for the list tests that need to know where a row sits (#3675). jsdom
 * lays nothing out and answers every `getBoundingClientRect` with zeros, so a
 * case that holds the reader's place has nothing to hold. This lays the rows of
 * a list out the way a scroller would: each `<li>` is @p rowHeight tall, the
 * list starts at the top of its parent, and the parent's `scrollTop` moves them.
 * Restored when the test finishes.
 */

import { onTestFinished, vi } from "vitest";

/** Give @p scroller a `scrollTop` a case can set and a hook can move. */
export function makeScrollable(scroller: HTMLElement, scrollTop = 0): void {
	Object.defineProperty(scroller, "scrollTop", {
		configurable: true,
		writable: true,
		value: scrollTop,
	});
}

export function stubRowLayout(rowHeight: number): void {
	const spy = vi
		.spyOn(HTMLLIElement.prototype, "getBoundingClientRect")
		.mockImplementation(function (this: HTMLLIElement) {
			const list = this.parentElement;
			const top = list ? Array.prototype.indexOf.call(list.children, this) * rowHeight : 0;
			const scrolled = list?.parentElement?.scrollTop ?? 0;
			return new DOMRect(0, top - scrolled, 0, rowHeight);
		});
	onTestFinished(() => spy.mockRestore());
}
