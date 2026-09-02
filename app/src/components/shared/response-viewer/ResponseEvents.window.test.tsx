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
 * The Events list renders a window, and its rows do not re-render for each
 * other (issue #1158).
 *
 * A stream runs to 100,000 events by default and ten million at the ceiling,
 * and every row here is a chip, a monospace preview and an expandable payload -
 * so the list is sliced, and the slice grows as its end is reached. The slice
 * alone is not enough: a live list *grows in place*, so a window keyed on the
 * row count would snap back to its first slice on every batch that landed, and
 * an unmemoized row would re-render the whole visible list for one arrival.
 *
 * Row renders are counted through `toLocaleTimeString`, which each row calls
 * once for its timestamp and nothing else in this component calls at all.
 *
 * jsdom has no `IntersectionObserver` and `useGrowingWindow` degrades to
 * showing everything there, so these stub one that only intersects when a case
 * asks it to - the same stub `useGrowingWindow.test.tsx` uses, for the same
 * reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import type { StreamEvent } from "@/types";
import ResponseEvents from "./ResponseEvents";

/** The observer the list attaches to its sentinel, held so a case can fire it. */
let intersect: (() => void) | null = null;

beforeEach(() => {
	intersect = null;
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private readonly callback: IntersectionObserverCallback) {}
			observe() {
				intersect = () =>
					this.callback(
						[{ isIntersecting: true } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver
					);
			}
			disconnect() {
				intersect = null;
			}
		}
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/**
 * @p count events, each a stable object - the identity a live stream gives
 * them, since a frame is appended once and never replaced.
 */
function stream(count: number): StreamEvent[] {
	return Array.from({ length: count }, (_, i) => ({
		event: "token",
		data: `event ${i}`,
		receivedAt: 1_750_000_000_000 + i,
	}));
}

/** Every row currently in the DOM - one expandable button each. */
const rows = () => screen.getAllByRole("button", { expanded: false });

/** Reach the end of the list, the way scrolling to the sentinel does. */
const scrollToEnd = () => act(() => intersect?.());

describe("ResponseEvents render window", () => {
	it("renders one step of a long list and says how much of it is showing", () => {
		render(<ResponseEvents events={stream(500)} isStream listKey="run_1" />);

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP);
		expect(
			screen.getByText(`Showing ${GROWING_WINDOW_STEP} of 500 rows - scroll for more.`)
		).toBeInTheDocument();
	});

	it("renders a short list whole, with no sentinel", () => {
		render(<ResponseEvents events={stream(3)} isStream listKey="run_1" />);

		expect(rows()).toHaveLength(3);
		expect(screen.queryByText(/scroll for more/)).not.toBeInTheDocument();
	});

	it("keeps the window where the reader left it when a batch lands", () => {
		const events = stream(500);
		const { rerender } = render(
			<ResponseEvents events={events} isStream isStreaming listKey="run_1" />
		);

		scrollToEnd();
		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);

		// The list this reader is looking at is the same list, one batch longer.
		// Keyed on the row count - the hook's default - this is where it would
		// snap back to the first slice, mid-scroll, on every flush.
		rerender(
			<ResponseEvents
				events={[...events, ...stream(4)]}
				isStream
				isStreaming
				listKey="run_1"
			/>
		);

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);
	});

	it("starts a different list at the top", () => {
		const { rerender } = render(
			<ResponseEvents events={stream(500)} isStream isStreaming listKey="run_1" />
		);

		scrollToEnd();
		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);

		// A second Send is a different stream, not more of this one.
		rerender(<ResponseEvents events={stream(500)} isStream isStreaming listKey="run_2" />);

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP);
	});

	it("re-renders only the rows a batch actually added", () => {
		const events = stream(40);
		const clock = vi.spyOn(Date.prototype, "toLocaleTimeString");

		const { rerender } = render(
			<ResponseEvents events={events} isStream isStreaming listKey="run_1" />
		);
		expect(clock).toHaveBeenCalledTimes(40);
		clock.mockClear();

		// Two events arrive. Without `memo` on the row, all 42 rows render for
		// them - which is the cost this whole list is here to avoid.
		rerender(
			<ResponseEvents
				events={[...events, ...stream(2)]}
				isStream
				isStreaming
				listKey="run_1"
			/>
		);

		expect(rows()).toHaveLength(42);
		expect(clock).toHaveBeenCalledTimes(2);
	});
});
