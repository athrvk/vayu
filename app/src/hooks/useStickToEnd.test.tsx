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
 * A list that follows its end keeps following while its rows settle (#3671).
 *
 * jsdom lays nothing out, so the scroller here is modelled by hand: a
 * `scrollHeight` the case grows (what `content-visibility: auto` does a frame
 * after the pin), a `scrollTop` clamped to the real maximum the way a browser
 * clamps it, and a `ResizeObserver` the case fires.
 *
 * Mutation checks (revert, confirm red, restore): drop the observer's `pin()`
 * and the "settles after the pin" case reds on the `scrollTop`; drop the
 * `pinnedTop` comparison in `onScroll` and the same case reds on "following"
 * (the pin's own scroll event reads a gap of 66px). For the caller's own scroll
 * (#3674): hand `scrollOwn`'s `move` straight to the caller without recording its
 * position and the "caller's scroll" case reds on "following"; drop the
 * `ownTop` clear in `onScroll` and the "only the one event" case reds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { END_TOLERANCE_PX, useStickToEnd } from "./useStickToEnd";

const VIEWPORT = 100;

interface HarnessProps {
	rows: readonly number[];
	canResume?: boolean;
	showList?: boolean;
}

/** What the "move" button scrolls the scroller with: the caller's own scroll. */
let callerMove: () => void = () => {};

function Harness({ rows, canResume, showList = true }: HarnessProps) {
	const scroller = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const { onScroll, listRef, scrollOwn } = useStickToEnd(scroller, {
		following,
		onFollowingChange: setFollowing,
		canResume,
		rows,
	});
	return (
		<div ref={scroller} onScroll={onScroll} data-testid="scroller" data-following={following}>
			<button type="button" onClick={() => scrollOwn(() => callerMove())}>
				move
			</button>
			{showList && (
				<ul ref={listRef}>
					{rows.map((row) => (
						<li key={row}>row {row}</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The observers the hook created, so a case can say the list's box resized. */
let observers: { observed: Element[]; disconnected: boolean; fire: () => void }[];
let contentHeight: number;
let top: number;

beforeEach(() => {
	observers = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			private readonly record = {
				observed: [] as Element[],
				disconnected: false,
				fire: () => {},
			};
			constructor(callback: ResizeObserverCallback) {
				this.record.fire = () => callback([], this as unknown as ResizeObserver);
				observers.push(this.record);
			}
			observe(node: Element) {
				this.record.observed.push(node);
			}
			disconnect() {
				this.record.disconnected = true;
			}
		}
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Lay the scroller out: @p height of content in a 100px box, `scrollTop` clamped to what scrolls. */
function layOut(scroller: HTMLElement, height: number) {
	contentHeight = height;
	top = 0;
	Object.defineProperty(scroller, "scrollHeight", {
		configurable: true,
		get: () => contentHeight,
	});
	Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEWPORT });
	Object.defineProperty(scroller, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value: number) => {
			top = Math.min(Math.max(value, 0), contentHeight - VIEWPORT);
		},
	});
}

const scroller = () => screen.getByTestId("scroller");
const isFollowing = () => scroller().dataset.following === "true";

/** Mount, lay the scroller out, then hand the hook new rows: the pin has a height to read. */
function mount(props: HarnessProps, height: number) {
	const view = render(<Harness {...props} showList={false} />);
	layOut(scroller(), height);
	view.rerender(<Harness {...props} rows={[...props.rows]} />);
	return view;
}

/** The reader scrolls to @p to. */
function readerScrollsTo(to: number) {
	top = to;
	fireEvent.scroll(scroller());
}

/** The caller scrolls to @p to through `scrollOwn`; the browser reports it as a scroll event a frame later. */
function callerScrollsTo(to: number) {
	callerMove = () => {
		top = to;
	};
	fireEvent.click(screen.getByRole("button", { name: "move" }));
	fireEvent.scroll(scroller());
}

const resize = () => act(() => observers[observers.length - 1]!.fire());

describe("useStickToEnd", () => {
	it("pins the list to its end when it mounts and when the rows change", () => {
		const view = mount({ rows: [1, 2, 3] }, 1000);
		expect(scroller().scrollTop).toBe(900);

		contentHeight = 1100;
		view.rerender(<Harness rows={[1, 2, 3, 4]} />);
		expect(scroller().scrollTop).toBe(1000);
		expect(isFollowing()).toBe(true);
	});

	it("keeps following when the rows settle to a larger height after the pin", () => {
		mount({ rows: [1, 2, 3] }, 1000);
		expect(scroller().scrollTop).toBe(900);

		// The rows resolve from their estimates: 66px more than the pin saw.
		contentHeight = 1066;
		// The scroll event the pin caused arrives now and reads a gap of 66px.
		fireEvent.scroll(scroller());
		expect(isFollowing()).toBe(true);

		resize();
		expect(scroller().scrollTop).toBe(966);
		expect(isFollowing()).toBe(true);
	});

	it("observes the element the rows are in, and stops when it goes", () => {
		const view = mount({ rows: [1] }, 1000);
		const observer = observers[observers.length - 1]!;
		expect(observer.observed).toEqual([scroller().querySelector("ul")]);

		view.rerender(<Harness rows={[1]} showList={false} />);
		expect(observer.disconnected).toBe(true);
	});

	it("stops following when the reader scrolls up, and leaves the list where they put it", () => {
		const view = mount({ rows: [1, 2, 3] }, 1000);

		readerScrollsTo(300);
		expect(isFollowing()).toBe(false);

		contentHeight = 1100;
		view.rerender(<Harness rows={[1, 2, 3, 4]} />);
		resize();
		expect(scroller().scrollTop).toBe(300);
		expect(isFollowing()).toBe(false);
	});

	it("follows again when the reader scrolls back to the end", () => {
		const view = mount({ rows: [1, 2, 3] }, 1000);
		readerScrollsTo(300);
		expect(isFollowing()).toBe(false);

		readerScrollsTo(900 - END_TOLERANCE_PX);
		expect(isFollowing()).toBe(true);

		contentHeight = 1100;
		view.rerender(<Harness rows={[1, 2, 3, 4]} />);
		expect(scroller().scrollTop).toBe(1000);
	});

	it("does not follow again on a scroll that stops short of the end", () => {
		mount({ rows: [1, 2, 3] }, 1000);
		readerScrollsTo(300);
		readerScrollsTo(900 - END_TOLERANCE_PX - 1);
		expect(isFollowing()).toBe(false);
	});

	it("leaves a reader at the end where they are when the caller refuses to resume", () => {
		mount({ rows: [1, 2, 3], canResume: false }, 1000);
		readerScrollsTo(300);
		readerScrollsTo(900);
		expect(isFollowing()).toBe(false);
	});

	it("does not read the caller's own scroll to the end as the reader arriving there", () => {
		mount({ rows: [1, 2, 3] }, 1000);
		readerScrollsTo(300);
		expect(isFollowing()).toBe(false);

		callerScrollsTo(900 - END_TOLERANCE_PX);

		expect(isFollowing()).toBe(false);
	});

	it("ignores only the one event of the caller's scroll: the reader arriving at the same place later follows", () => {
		mount({ rows: [1, 2, 3] }, 1000);
		readerScrollsTo(300);
		callerScrollsTo(900 - END_TOLERANCE_PX);
		readerScrollsTo(300);
		expect(isFollowing()).toBe(false);

		readerScrollsTo(900 - END_TOLERANCE_PX);

		expect(isFollowing()).toBe(true);
	});

	it("does not pin on a resize while the reader is scrolled away", () => {
		mount({ rows: [1, 2, 3] }, 1000);
		readerScrollsTo(300);

		contentHeight = 1066;
		resize();
		expect(scroller().scrollTop).toBe(300);
	});
});
