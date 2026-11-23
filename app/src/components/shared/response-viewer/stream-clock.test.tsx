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
 * An open stream's status bar counts up (#3775).
 *
 * A stream's `time` is held at 0 until its run settles, so the bar read "0 ms"
 * for as long as tokens were arriving. The clock is the one number on the bar
 * that is true while the stream is open, and it gives way to `time` when the
 * stream ends - both halves are asserted, since a clock that outlived the
 * stream would contradict the figure the finished run stored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { TIMING } from "@/config/timing";
import { ResponseStatusBar } from "./ResponseStatusBar";

const SENT_AT = 1_700_000_000_000;

describe("the status bar's time while a stream is open", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(SENT_AT);
	});
	afterEach(() => vi.useRealTimers());

	it("counts up from the moment the stream started", () => {
		render(
			<ResponseStatusBar
				status={200}
				statusText="OK"
				time={0}
				streaming={{ events: 0, sentAt: SENT_AT - 250 }}
			/>
		);
		// Mutation check: draw `time` while streaming (drop the `ElapsedClock`
		// branch) and the bar reads "0 ms" for the whole stream.
		expect(screen.getByText("250 ms")).toBeTruthy();
		expect(screen.queryByText("0 ms")).toBeNull();

		act(() => {
			vi.advanceTimersByTime(TIMING.STREAM_CLOCK_TICK_MS * 12);
		});
		expect(screen.getByText("1.45 s")).toBeTruthy();
	});

	it("moves on its own, without a new prop", () => {
		render(
			<ResponseStatusBar status={200} time={0} streaming={{ events: 3, sentAt: SENT_AT }} />
		);
		expect(screen.getByText("0 ms")).toBeTruthy();

		// Mutation check: drop the interval in `ElapsedClock` and this stays "0 ms".
		act(() => {
			vi.advanceTimersByTime(TIMING.STREAM_CLOCK_TICK_MS * 3);
		});
		expect(screen.getByText("300 ms")).toBeTruthy();
	});

	it("gives way to the run's own time once the stream has ended", () => {
		const { rerender } = render(
			<ResponseStatusBar
				status={200}
				time={0}
				streaming={{ events: 3, sentAt: SENT_AT - 5000 }}
			/>
		);
		expect(screen.getByText("5.00 s")).toBeTruthy();

		rerender(<ResponseStatusBar status={200} time={4210} />);
		expect(screen.getByText("4.21 s")).toBeTruthy();
		expect(screen.queryByText("5.00 s")).toBeNull();

		// Nothing left ticking once the clock is gone.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows `time` for a stream whose start is not known", () => {
		render(<ResponseStatusBar status={200} time={37} streaming={{ events: 1 }} />);

		expect(screen.getByText("37 ms")).toBeTruthy();
	});
});
