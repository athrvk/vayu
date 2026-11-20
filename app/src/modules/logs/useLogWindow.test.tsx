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
 * The Logs list's window (#3670): which rows of the held lines are mounted,
 * as the tail appends, the store trims and each sentinel is reached.
 *
 * Mutation checks (revert, confirm red, restore): drop the clamp on a first
 * row the store has dropped and the trim case reds; drop `droppedNewest` and the newest-end case lands on the oldest rows; drop the cap from
 * `grownUp` or `grownDown` and its sentinel case mounts past
 * `LOG_WINDOW_MAX_ROWS`; drop the `beforeGrowUp` call and the "tells the caller" case reds; re-anchor only on a new generation and the Follow off,
 * trim and bottom sentinel cases lose the reader's rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { LogEntry } from "@/types/electron";
import { logRecord } from "./logs-bridge.testkit";
import { stubSentinelObserver, type SentinelObserver } from "@/test/sentinel-observer.testkit";
import { LOG_WINDOW_MAX_ROWS, LOG_WINDOW_STEP, useLogWindow } from "./useLogWindow";

const lines = (from: number, to: number): LogEntry[] =>
	Array.from({ length: to - from }, (_, n) => logRecord(from + n));

/** The line numbers @p shown spans, first and last, as `logRecord` numbered them. */
function span(shown: LogEntry[]): [string, string] {
	const message = (entry: LogEntry | undefined) =>
		entry && "msg" in entry ? String(entry.msg) : "none";
	return [message(shown[0]), message(shown[shown.length - 1])];
}

interface Props {
	records: LogEntry[];
	follow: boolean;
	generation: number;
}

function renderWindow(initial: Props, beforeGrowUp?: () => void) {
	return renderHook(
		(props: Props) => useLogWindow(props.records, props.follow, props.generation, beforeGrowUp),
		{
			initialProps: initial,
		}
	);
}

let observer: SentinelObserver;

beforeEach(() => {
	observer = stubSentinelObserver();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Attach each sentinel the window asks for, as `LogList` renders them. */
function attach(view: ReturnType<typeof renderWindow>) {
	const top = document.createElement("div");
	const bottom = document.createElement("div");
	act(() => {
		view.result.current.topSentinelRef(top);
		view.result.current.bottomSentinelRef(bottom);
	});
	return { top, bottom };
}

describe("useLogWindow", () => {
	it("mounts the newest step and moves with the tail while following", () => {
		const records = lines(0, 300);
		const view = renderWindow({ records, follow: true, generation: 1 });

		expect(view.result.current.shown).toHaveLength(LOG_WINDOW_STEP);
		expect(span(view.result.current.shown)).toEqual(["line 100", "line 299"]);
		expect(view.result.current.hasAbove).toBe(true);
		expect(view.result.current.hasBelow).toBe(false);

		view.rerender({ records: [...records, ...lines(300, 350)], follow: true, generation: 1 });

		expect(span(view.result.current.shown)).toEqual(["line 150", "line 349"]);
	});

	it("stays on the reader's rows when Follow turns off, and leaves lines appended below unmounted", () => {
		const records = lines(0, 300);
		const view = renderWindow({ records, follow: true, generation: 1 });
		view.rerender({ records, follow: false, generation: 1 });

		view.rerender({
			records: [...records, ...lines(300, 1_000)],
			follow: false,
			generation: 1,
		});

		expect(span(view.result.current.shown)).toEqual(["line 100", "line 299"]);
		expect(view.result.current.hasBelow).toBe(true);
	});

	it("keeps its first row through a trim of the oldest, and starts at the oldest held once that row goes", () => {
		const records = lines(0, 300);
		const view = renderWindow({ records, follow: true, generation: 1 });
		view.rerender({ records, follow: false, generation: 1 });

		view.rerender({
			records: [...records.slice(50), ...lines(300, 350)],
			follow: false,
			generation: 1,
		});
		expect(span(view.result.current.shown)).toEqual(["line 100", "line 299"]);

		view.rerender({
			records: [...records.slice(150), ...lines(300, 400)],
			follow: false,
			generation: 1,
		});
		expect(span(view.result.current.shown)).toEqual(["line 150", "line 349"]);
		expect(view.result.current.hasAbove).toBe(false);
	});

	it("lands on the newest rows when the store drops the reader's rows off the newest end", () => {
		const records = lines(0, 1_000);
		const view = renderWindow({ records, follow: true, generation: 1 });
		view.rerender({ records, follow: false, generation: 1 });
		expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);

		// Search older: a page prepended, the newest dropped to hold the bound.
		view.rerender({ records: lines(-300, 700), follow: false, generation: 1 });
		expect(span(view.result.current.shown)).toEqual(["line 500", "line 699"]);
		expect(view.result.current.hasBelow).toBe(false);
	});

	it("grows a step older at the top sentinel, and past the cap gives up the newest rows", () => {
		const records = lines(0, LOG_WINDOW_MAX_ROWS + LOG_WINDOW_STEP + 1);
		const view = renderWindow({ records, follow: false, generation: 1 });
		const { top } = attach(view);
		expect(span(view.result.current.shown)).toEqual(["line 601", "line 800"]);

		act(() => observer.reach(top));
		expect(span(view.result.current.shown)).toEqual(["line 401", "line 800"]);
		act(() => observer.reach(top));
		expect(view.result.current.shown).toHaveLength(LOG_WINDOW_MAX_ROWS);
		act(() => observer.reach(top));

		expect(view.result.current.shown).toHaveLength(LOG_WINDOW_MAX_ROWS);
		expect(span(view.result.current.shown)).toEqual(["line 1", "line 600"]);
		expect(view.result.current.hasBelow).toBe(true);
	});

	it("tells the caller before the top sentinel grows the window, and not for the bottom one", () => {
		// The caller holds the reader's place across a growth above them (#3675).
		const beforeGrowUp = vi.fn();
		const records = lines(0, 1_000);
		const view = renderWindow({ records, follow: false, generation: 1 }, beforeGrowUp);
		const { top, bottom } = attach(view);

		act(() => observer.reach(bottom));
		expect(beforeGrowUp).not.toHaveBeenCalled();

		act(() => observer.reach(top));
		expect(beforeGrowUp).toHaveBeenCalledTimes(1);
		expect(view.result.current.shown).toHaveLength(2 * LOG_WINDOW_STEP);
	});

	it("mounts the next step at the bottom sentinel, and past the cap gives up the oldest rows", () => {
		const records = lines(0, 300);
		const view = renderWindow({ records, follow: true, generation: 1 });
		view.rerender({ records, follow: false, generation: 1 });
		const grown = [...records, ...lines(300, 1_000)];
		view.rerender({ records: grown, follow: false, generation: 1 });
		const { bottom } = attach(view);

		act(() => observer.reach(bottom));
		expect(span(view.result.current.shown)).toEqual(["line 100", "line 499"]);
		act(() => observer.reach(bottom));
		expect(span(view.result.current.shown)).toEqual(["line 100", "line 699"]);
		act(() => observer.reach(bottom));

		expect(view.result.current.shown).toHaveLength(LOG_WINDOW_MAX_ROWS);
		expect(span(view.result.current.shown)).toEqual(["line 300", "line 899"]);
		expect(view.result.current.hasAbove).toBe(true);
	});

	it("starts at the newest step again when the list is replaced", () => {
		const records = lines(0, 1_000);
		const view = renderWindow({ records, follow: false, generation: 1 });
		const { top } = attach(view);
		act(() => observer.reach(top));
		expect(view.result.current.shown).toHaveLength(2 * LOG_WINDOW_STEP);

		const replaced = lines(2_000, 2_500);
		view.rerender({ records: replaced, follow: false, generation: 2 });

		expect(span(view.result.current.shown)).toEqual(["line 2300", "line 2499"]);
	});

	it("mounts every row where there is no observer to reach the rest by", () => {
		vi.unstubAllGlobals();
		vi.stubGlobal("IntersectionObserver", undefined);
		const records = lines(0, 1_000);

		const view = renderWindow({ records, follow: false, generation: 1 });

		expect(view.result.current.shown).toHaveLength(1_000);
		expect(view.result.current.hasAbove).toBe(false);
		expect(view.result.current.hasBelow).toBe(false);
	});
});
