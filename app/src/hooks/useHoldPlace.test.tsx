/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A window that grows upward keeps the reader's place (#3675).
 *
 * The cases drive `useGrowingWindow` the way the Console does, through a real
 * scroller laid out by `stubRowLayout`, and the observer stub models what the
 * real one does and a bare stub does not: it reports a sentinel when it *enters*
 * the view, never while it stays there. So a window that does not move the reader
 * off the sentinel grows once and then waits for a scroll that cannot come.
 *
 * Mutation checks (revert, confirm red, restore): drop the `scrollTop` correction
 * in `useHoldPlace` and the first two cases red - the scroller stays at 0, the
 * sentinel is still in view after the first growth, and the window stops at 400
 * rows; add the row's new position instead of how far it moved and the
 * "browser already held the view" case reds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { makeScrollable, stubRowLayout } from "@/test/row-layout.testkit";
import { stubSentinelObserver, type SentinelObserver } from "@/test/sentinel-observer.testkit";
import { GROWING_WINDOW_STEP, useGrowingWindow } from "./useGrowingWindow";
import { useHoldPlace } from "./useHoldPlace";

const ROW_HEIGHT = 20;
const TOTAL = 1_000;

/** The Console's shape: the newest `visible` rows, and a sentinel above them. */
function UpwardList({ withHold = true }: { withHold?: boolean }) {
	const scroller = useRef<HTMLDivElement>(null);
	const holdPlace = useHoldPlace(scroller);
	const { visible, sentinelRef, hasMore } = useGrowingWindow(
		TOTAL,
		GROWING_WINDOW_STEP,
		"list",
		withHold ? holdPlace : undefined
	);
	return (
		<div ref={scroller} data-testid="scroller">
			{hasMore && <div ref={sentinelRef} data-testid="sentinel" />}
			<ul>
				{Array.from({ length: visible }, (_, n) => TOTAL - visible + n).map((id) => (
					<li key={id}>row {id}</li>
				))}
			</ul>
		</div>
	);
}

let observer: SentinelObserver;
/** Whether the sentinel is in the view: it sits at the top of the content, so only at `scrollTop` 0. */
let inView = false;

beforeEach(() => {
	observer = stubSentinelObserver();
	stubRowLayout(ROW_HEIGHT);
	inView = false;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const scroller = () => screen.getByTestId("scroller");
const mounted = () => scroller().querySelectorAll("li").length;

/** The reader scrolls to @p top; the observer reports the sentinel if that brings it into view. */
function scrollTo(top: number) {
	scroller().scrollTop = top;
	const nowInView = top <= 0;
	if (nowInView && !inView) act(() => observer.reach(screen.getByTestId("sentinel")));
	inView = scroller().scrollTop <= 0;
}

function renderList(withHold = true) {
	render(<UpwardList withHold={withHold} />);
	makeScrollable(scroller(), 0);
	// Mounted at the end, as the Console is; the reader has scrolled back to the top.
	inView = false;
}

describe("growing upward", () => {
	it("moves the scroller by the height added above, and grows again on the next scroll up", () => {
		renderList();

		scrollTo(0);
		expect(mounted()).toBe(2 * GROWING_WINDOW_STEP);
		expect(scroller().scrollTop).toBe(GROWING_WINDOW_STEP * ROW_HEIGHT);

		scrollTo(0);
		expect(mounted()).toBe(3 * GROWING_WINDOW_STEP);
		expect(scroller().scrollTop).toBe(GROWING_WINDOW_STEP * ROW_HEIGHT);
	});

	it("reaches the oldest row by steady scrolling up", () => {
		renderList();

		for (let reach = 1; reach < TOTAL / GROWING_WINDOW_STEP; reach++) scrollTo(0);

		expect(mounted()).toBe(TOTAL);
		expect(screen.queryByTestId("sentinel")).toBeNull();
		expect(screen.getByText("row 0")).toBeInTheDocument();
	});

	it("adds nothing where the browser already held the view", () => {
		renderList();
		// The browser anchored: the first row is where it was by the time the commit lands.
		const element = scroller();
		vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockImplementation(
			() => new DOMRect(0, 100, 0, ROW_HEIGHT)
		);

		scrollTo(0);

		expect(mounted()).toBe(2 * GROWING_WINDOW_STEP);
		expect(element.scrollTop).toBe(0);
	});

	it("does not move the scroller for a window that asks for no hold", () => {
		renderList(false);

		scrollTo(0);

		expect(mounted()).toBe(2 * GROWING_WINDOW_STEP);
		expect(scroller().scrollTop).toBe(0);
	});
});
