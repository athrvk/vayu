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
 * trim and bottom sentinel cases lose the reader's rows. For a jump (#3674):
 * drop `boundsAroundTarget` from `boundsOf` and the cases that open the window
 * on the time land on the newest rows; clamp the start to
 * `records.length - count` no longer and the case near the newest rows mounts a
 * short window. While the page newer is read (`jumpPaging`): make `unsettled`
 * `false` in `boundsOf` and the cases that reach the top sentinel, hold a line
 * timed at the instant, or hold no line after it, stay on the rows they first
 * showed instead of opening on the time; drop the `unsettled` guard from
 * `grownUp` and the top sentinel case grows the window; drop it from `growUp`
 * and the case that counts `beforeGrowUp` calls reds.
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
	/** The instant a jump landed on; none when the list was not replaced by one. */
	jumpTarget?: string | null;
	/** The jump's first page newer is still being read; false once it has landed. */
	jumpPaging?: boolean;
}

function renderWindow(initial: Props, beforeGrowUp?: () => void) {
	return renderHook(
		(props: Props) =>
			useLogWindow(
				props.records,
				props.follow,
				props.generation,
				beforeGrowUp,
				props.jumpTarget ?? null,
				props.jumpPaging ?? false
			),
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

	describe("after a jump", () => {
		const at = (n: number) => logRecord(n).ts;

		it("opens on a few rows before the time, though more than a step is newer than it", () => {
			const records = lines(0, 1_000);
			const view = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(500),
			});

			expect(span(view.result.current.shown)).toEqual(["line 450", "line 649"]);
			expect(view.result.current.jumpAt).toBe(50);
			expect(view.result.current.hasAbove).toBe(true);
			expect(view.result.current.hasBelow).toBe(true);
		});

		it("keeps the window full when the time is among the newest rows", () => {
			const records = lines(0, 1_000);
			const view = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(990),
			});

			expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);
			expect(view.result.current.jumpAt).toBe(190);
		});

		it("opens at the oldest row when fewer rows than the context precede the time", () => {
			const records = lines(0, 1_000);
			const view = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(10),
			});

			expect(span(view.result.current.shown)).toEqual(["line 0", "line 199"]);
			expect(view.result.current.jumpAt).toBe(10);
		});

		it("is the first row at or after a time that falls between two lines, and at a line's own", () => {
			const records = lines(0, 300);
			const between = new Date(Date.parse(at(150)) - 500).toISOString();

			const view = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: between,
			});
			const exact = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(150),
			});

			expect(view.result.current.jumpAt).toBe(exact.result.current.jumpAt);
			const shown = view.result.current.shown;
			expect(shown[view.result.current.jumpAt ?? -1]).toBe(records[150]);
		});

		it("skips a line with no time, which is neither before nor after it", () => {
			const unparsed: LogEntry = { unparsed: true, raw: "SEGFAULT" };
			const records = [...lines(0, 5), unparsed, ...lines(5, 10)];
			const view = renderWindow({ records, follow: false, generation: 1, jumpTarget: at(5) });

			// The marker sits before line 5, the first dated line at the time, so the unparsed line is above it.
			expect(view.result.current.jumpAt).toBe(6);
			expect(view.result.current.shown[6]).toBe(records[6]);
		});

		it("sits at the end of the newest rows while no line is at or after the time, then moves onto it", () => {
			const records = lines(0, 1_000);
			const paging = {
				follow: false,
				generation: 1,
				jumpTarget: at(1_000),
				jumpPaging: true,
			};
			const view = renderWindow({ records, ...paging });
			expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);
			expect(view.result.current.jumpAt).toBe(LOG_WINDOW_STEP);

			// The page newer lands below.
			view.rerender({
				records: [...records, ...lines(1_000, 1_100)],
				...paging,
				jumpPaging: false,
			});

			expect(span(view.result.current.shown)).toEqual(["line 900", "line 1099"]);
			expect(view.result.current.jumpAt).toBe(100);
		});

		describe("while the first page newer is being read", () => {
			const paging = { follow: false, generation: 1, jumpPaging: true };

			it("is not grown by the top sentinel, so the page's arrival still opens it on the time", () => {
				const records = lines(0, 1_000);
				const beforeGrowUp = vi.fn();
				const props = { ...paging, jumpTarget: at(1_000) };
				const view = renderWindow({ records, ...props }, beforeGrowUp);
				const { top } = attach(view);

				// The newest rows are what is shown, and their top sentinel is in view.
				act(() => observer.reach(top));
				expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);
				expect(beforeGrowUp).not.toHaveBeenCalled();

				view.rerender({
					records: [...records, ...lines(1_000, 1_100)],
					...props,
					jumpPaging: false,
				});

				expect(span(view.result.current.shown)).toEqual(["line 900", "line 1099"]);
				expect(view.result.current.jumpAt).toBe(100);
			});

			it("is not grown by the bottom sentinel either", () => {
				const records = lines(0, 1_000);
				const props = { ...paging, jumpTarget: at(500) };
				const view = renderWindow({ records, ...props });
				const { bottom } = attach(view);

				act(() => observer.reach(bottom));
				view.rerender({
					records: [...records, ...lines(1_000, 1_100)],
					...props,
					jumpPaging: false,
				});

				expect(span(view.result.current.shown)).toEqual(["line 450", "line 649"]);
			});

			it("opens on the time the page newer lands beside, though a line at the instant was already held", () => {
				const records = lines(0, 1_000);
				const props = { ...paging, jumpTarget: at(990) };
				const view = renderWindow({ records, ...props });
				// Shown on the time at once, as the page the jump read held a line for it.
				expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);
				expect(view.result.current.jumpAt).toBe(190);

				view.rerender({
					records: [...records, ...lines(1_000, 1_100)],
					...props,
					jumpPaging: false,
				});

				expect(span(view.result.current.shown)).toEqual(["line 900", "line 1099"]);
				expect(view.result.current.jumpAt).toBe(90);
			});

			it("settles on the newest rows when the page carries no line to open on, and stays there as a later page lands", () => {
				const unparsed = (n: number): LogEntry => ({ unparsed: true, raw: `trace ${n}` });
				const trace = (from: number, to: number) =>
					Array.from({ length: to - from }, (_, n) => unparsed(from + n));
				const records = [...lines(0, 1_000), ...trace(0, 50)];
				const props = { follow: false, generation: 1, jumpTarget: at(1_000) };
				const view = renderWindow({ records, ...props, jumpPaging: true });

				// The first page newer is 100 lines of a stack trace: none is timed.
				const landed = [...records, ...trace(50, 150)];
				view.rerender({ records: landed, ...props, jumpPaging: false });
				const settled = view.result.current.shown;
				expect(settled).toHaveLength(LOG_WINDOW_STEP);
				expect(view.result.current.jumpAt).toBe(LOG_WINDOW_STEP);

				// Search newer: timed lines past the time. The reader's rows do not move under them.
				view.rerender({
					records: [...landed, ...lines(1_000, 1_100)],
					...props,
					jumpPaging: false,
				});
				expect(view.result.current.shown).toEqual(settled);
			});
		});

		it("stays on those rows as lines are appended below once it has opened", () => {
			const records = lines(0, 1_100);
			const props = { follow: false, generation: 1, jumpTarget: at(1_000) };
			const view = renderWindow({ records, ...props });
			expect(span(view.result.current.shown)).toEqual(["line 900", "line 1099"]);

			view.rerender({ records: [...records, ...lines(1_100, 1_300)], ...props });

			expect(span(view.result.current.shown)).toEqual(["line 900", "line 1099"]);
		});

		it("follows the newest rows, with no rule off the window, when Follow is on", () => {
			const records = lines(0, 1_000);
			const view = renderWindow({
				records,
				follow: true,
				generation: 1,
				jumpTarget: at(500),
			});

			expect(span(view.result.current.shown)).toEqual(["line 800", "line 999"]);
			expect(view.result.current.jumpAt).toBeNull();
		});

		it("has no place for the rule once the cap gives up the rows beside the time", () => {
			const records = lines(0, 2_000);
			const view = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(500),
			});
			const { bottom } = attach(view);

			for (let step = 0; step < 3; step++) act(() => observer.reach(bottom));

			expect(span(view.result.current.shown)).toEqual(["line 650", "line 1249"]);
			expect(view.result.current.jumpAt).toBeNull();
		});

		it("returns no place without a jump, and a target no row follows is at the end where there is no observer", () => {
			vi.unstubAllGlobals();
			vi.stubGlobal("IntersectionObserver", undefined);
			const records = lines(0, 300);

			const plain = renderWindow({ records, follow: false, generation: 1 });
			const jumped = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(100),
			});
			const past = renderWindow({
				records,
				follow: false,
				generation: 1,
				jumpTarget: at(400),
			});

			expect(plain.result.current.jumpAt).toBeNull();
			expect(jumped.result.current.jumpAt).toBe(100);
			expect(past.result.current.jumpAt).toBe(300);
		});
	});
});
